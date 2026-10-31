# desk-setup step 1: detect, then confirm

Read at the start of step 1, after *0. Which repo, and where to start from*. The step table in
`../SKILL.md` names this file for it. The Memory ceiling row's default is in the core's *§3b:
the autonomy rows*, already loaded; *This computer*, *The pre-push hook* and *The desk gate
workflow*, which finish this step, each have their own file the table names.

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
- **Checks workers can't fix.** Search the repo instructions and the workflows for checks that fail
  until a person does something outside the code: an image built by hand, a credential, a service
  only they can reach ("run `ensure-flows-image.sh` if the Flows check says the image is missing").
  Propose each as `` `<check>: <what fixes it>` ``, the check named exactly as GitHub shows it; the
  user confirms each, and `none` is the default. Say that autopilot never sends a PR red only on one
  of these back to a worker: it is put to the user as stuck, with what fixes it.
- **Check builds.** Where what fixes such a check is a command run on this computer (a script that
  builds and pushes an image, "build it from the branch with: `./scripts/ensure-flows-image.sh`"),
  propose it for §4 Check builds as well as the row above, as `` `<check>: <command>` ``, the check
  named exactly as GitHub shows it and the command as the instructions give it, run from the repo
  root. Never leave it as prose only. The user confirms each; `none` is the default. Say that the
  autopilot pass runs the command once per head on this computer, in the ticket's worktree, for a
  draft whose only red checks it names, then re-runs them, and that it needs whatever that command
  needs in the supervisor's environment (a Docker context, cloud credentials).
- **Evidence workflow.** Look in the workflows for one that takes a PR's screenshots and writes them
  into its body (a `workflow_dispatch` with a `pr` input that replaces `_drag <file>_` cells, e.g.
  `pr-evidence.yml`). Where there is one, propose it for §4 Evidence workflow as `` `<file>.yml` ``;
  `none` is the default. Say that the autopilot pass starts it once per head for a draft whose body
  still has `_drag` cells and an `evidence` block, so those screenshots are never put to the user
  while it can take them.
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
  project in any directory other than the root (a `pyproject.toml`, `uv.lock` or
  `requirements*.txt` there: `apps/api/`, but also `backend/`, `services/` or `api/` at the top
  level) gets its own command items in its directory, e.g. `` `backend: uv run pytest` ``, and its
  `alembic.ini` a §4 Database migrate candidate. **It also gets its own §4 Install item**, beside
  the JS one, or a worker's worktree has no virtualenv and every backend ticket parks: with a
  committed `uv.lock` (`git ls-files <dir>/uv.lock`, not just on disk) propose
  `` `<dir>: uv sync --frozen` ``. With no committed `uv.lock`, ask how dependencies are installed
  there rather than proposing a command: a plain `uv sync` writes a new lockfile into every
  worktree, and `git status` is then never clean. Propose, then
  confirm; a guessed test command that does not exist wastes a worker's whole run.
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
- **Handoff at context % on a 1M window.** Propose `20`, with one line of why: replaying 71
  orchestrator sessions, a fresh start at about 200k tokens saved 53% of the tokens re-read each
  turn, against 10% at 45% of a 1M window (450k). A whole number from `1` to `99`, `0` to turn it off
  on 1M windows only, or empty to take the row above's value.
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
