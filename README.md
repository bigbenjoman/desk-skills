# desk-skills

Claude Code skills that take a ticket to a merged PR and a closed ticket, or work a batch of tickets
unattended. They are installed **once per machine** and **configured once per repo**: each
repository has its own Jira (or none), login, people, commands, checks, conventions and
permissions, and nothing set for one repo applies to another.

macOS, Linux and WSL.

## Quick start

```bash
gh repo clone bigbenjoman/desk-skills ~/desk-skills
cd ~/desk-skills && ./install.sh     # once per machine; asks before touching your settings
```

1. **Restart Claude Code**, so it loads the skills, agents and hook.
2. **`cd` into a repo and run `/desk-setup`.** It detects what it can, you confirm it, and it asks
   every permission for that repo, one question at a time. Allow 15–20 minutes the first time.
3. **Repeat step 2 in each repo.** From the second repo on, setup can start from an earlier repo's
   answers, and you confirm each one.
4. **Before the first autopilot batch in a repo**, run its preflight once (see
   [Checking a repo's setup](#checking-a-repos-setup)).

Then `/desk-ticket <TICKET>` for one ticket, or `/desk-autopilot <TICKET> <TICKET> …` for a batch.

## Skills

| Skill | What it does | Start it with |
|---|---|---|
| `desk-setup` | Detects this repo's Jira, checks, toolchain and conventions, asks what the skills may do here, then writes this repo's config | `/desk-setup` |
| `desk-ticket` | One ticket, from triage to merged PR | `/desk-ticket ABC-123` |
| `desk-autopilot` | A batch of tickets, one detached worker each, merged as each goes green | `/desk-autopilot ABC-1 ABC-2` |
| `desk-clearance` | Your open PRs: review comments, CI, branches behind the default branch, merging | `/desk-clearance` |
| `desk-cleanup` | Stale worktrees and branches, ticket statuses that drifted from GitHub | `/desk-cleanup` |
| `desk-checkout` | Drafts your end-of-day check-out from calendar, meeting notes, Jira, GitHub, Slack and Claude Code; never sends it | `/desk-checkout` |
| `desk-pr` | Opening or updating a PR, screenshots included | loads itself |
| `desk-jira` | Ticket comments, edits, transitions | loads itself |
| `desk-review-response` | Replying to and working a reviewer's comments | loads itself |
| `desk-dev` | Running the app locally, optionally against a copy of staging data | loads itself |

A "ticket" is whatever this repo names work by: a tracker key (`VPL-123`), another id you list in
setup (a planning id such as `P1-M14-FIX-1`, a bug id such as `BUG-119-5`), or, in a repo with no
tracker, a GitHub issue URL or a plain description.

## Subagents

Eleven named subagents, installed to `~/.claude/agents/` so they are available in every repo.
Each one starts by reading the repo it is in: its desk config if there is one, its `CLAUDE.md` /
`AGENTS.md` / `DESIGN.md`, and the stack it detects. None of them assumes a framework. Summon one
by first name ("Hello Bea", "ask Nadia").

| Agent | Model | Use for |
|---|---|---|
| `ada-devils-advocate` | opus | An adversarial second opinion; stress-testing a decision or plan; judging outputs |
| `bea-business-analyst` | opus | Turning a rough idea into a well-formed ticket in this repo's tracker (or a GitHub issue); never files without approval |
| `jim-solution-architect` | opus | Infrastructure and architecture across whatever clouds the repo uses |
| `karen-seo-optimizer` | sonnet | SEO, GEO and AEO on the repo's public site |
| `lena-code-reviewer` | opus | Critical, actionable review of a diff or PR against this repo's bar |
| `mira-playwright-expert` | opus | Playwright E2E, placing a test in the pyramid, hunting flake |
| `muriel-design-engineer` | sonnet | Figma to production components in the repo's design system |
| `nadia-security-auditor` | opus | Auth, tenant and role isolation, payment and media boundaries |
| `otto-ia-mapper` | opus | One role's slice of the product's screens, derived from the code (spawned by `/userflow`) |
| `suki-frontend-architect` | opus | Frontend architecture, the repo's design system, motion (Muriel when there is a Figma comp) |
| `theo-api-designer` | opus | API and contract design in the repo's API style, with expand-contract changes |

`/userflow` (in `commands/`) maps the product's information architecture: one Otto per role.
A repo that wants a tailored agent adds its own `.claude/agents/<name>.md`; Claude Code prefers
the project copy over the user-level one.

## Install

```bash
./install.sh            # install or update
./install.sh --check    # report missing tools, change nothing
./install.sh --yes      # accept the prompts (not large downloads)
```

What it does:

- **Writes without asking** (desk's own files; a copy you edited is backed up first):
  the skills (`~/.agents/skills/desk-*`, linked into `~/.claude/skills`), the subagents and
  `/userflow` (`~/.claude/agents`, `~/.claude/commands`; a same-named file you already had is backed
  up), the scripts (`~/.claude/desk/bin`), `desk-env` and `desk-jira` (`~/.local/bin`), and the
  attribution hook script.
- **Asks first** before changing `~/.claude/settings.json` (registering the hook, adding the
  always-on deny rules), installing plugins, replacing a `desk-jira` it didn't install, or patching
  the Playwright MCP.
- **Never** writes a repo config. That is `/desk-setup`'s job, per repo.

Requirements (`./install.sh --check` names anything missing):

| Tool | Notes |
|---|---|
| Claude Code, `git`, `curl`, `jq`, `node`, `python3` | |
| `gh` | `gh auth login -s repo,workflow` |
| `codex` | optional: cross-vendor review. `brew install --cask codex` or `npm i -g @openai/codex`, then `codex login` |
| `mise` | only for repos that pin tools through it |
| `lsof` | preinstalled on macOS; `apt install lsof` on Linux |
| `flock` | optional; a fallback lock is used without it |

## Setting up a repo

Run `/desk-setup` from inside the repo (any worktree of it works). Have ready:

- **A Jira API token**, if the repo uses Jira (<https://id.atlassian.com/manage-profile/security/api-tokens>).
  You write it to a file yourself when setup asks (the exact commands are below); setup never asks
  you to paste it into the chat.
- **Who reviews and owns what** in this repo, if it isn't just you.

What setup does, in order:

| Step | What happens | Your part |
|---|---|---|
| 0. Which repo | Says which repo it is configuring and where the config will live. Offers to start from another configured repo's answers. | Pick a starting repo, or start fresh |
| 1. Detect | Reads the repo and GitHub: default branch, required checks (branch protection **and** rulesets), merge method, lockfiles and scripts (Python under `apps/*` too), env files (names only), recent branch and PR-title conventions, Jira project and workflow states, checks that fail on most PRs. | Correct anything wrong, one table per section |
| 2. Permissions | One question per capability, four at a time, each with a recommended answer and what it unlocks and exposes. | Answer every row; anything unanswered is `no` |
| 3. Connectors | Checks that the tools a granted row needs are present (Atlassian, Slack, Figma, Vercel, Playwright). Never calls them. | Connect any that are missing |
| 4. Harness rules | Adds the always-on deny rules to `~/.claude/settings.json`, then offers allow rules for your `yes` rows, written **only** to this repo's `.claude/settings.local.json` (refused unless git ignores it). | Approve the plan |
| 5. Write | Writes the config and prints every row back. | Check the summary |

Re-running `/desk-setup` in a configured repo changes only what you ask to change. `/desk-setup
permissions` jumps straight to the permissions; `/desk-setup list` shows every configured repo.

### Jira login, per repo

Each repo's Jira login lives beside its config, so two repos can use two Atlassian sites or two
accounts. Setup prints these with the real folder filled in; you run them yourself:

```bash
d="$(desk-jira where --dir)"; mkdir -p "$d" && chmod 700 "$d"
printf %s you@example.com > "$d/jira-email"
printf %s '<api token>' > "$d/atlassian-token" && chmod 600 "$d/atlassian-token"
desk-jira where && desk-jira whoami      # shows the site, project and login it resolved
```

A repo with no Jira sets §4 Tracker to `none`; the ticket skills then work from a GitHub issue or a
plain description, and every Jira step is skipped.

## The config file

```
~/.config/desk/repos/
  bigbenjoman__voicepa/
    config.md            everything desk knows about this repo, and what it may do here
    jira-email           your Atlassian login for this repo's Jira site
    atlassian-token      an API token for it (chmod 600)
    harness-rules.json   the Claude Code permission rules setup added for this repo
  bigbenjoman__forewatt/
    ...
```

- **One folder per repo**, named from `git remote get-url origin` (`owner__name`, lower-case). Every
  worktree of a repo finds the same config. `desk-env where` shows which one applies where you are.
- **Nothing lives in the repo**, so nothing reaches git. The only file desk writes inside a repo is
  `.claude/settings.local.json` (your allow rules), and only when git ignores it.
- **A skill run in a repo with no config stops** and offers `/desk-setup`.

What each section holds (template and full rules: [`desk-config.md`](desk-config.md)):

| Section | Holds |
|---|---|
| §0 This repo | GitHub repo, default branch, a one-line description |
| §1 Who you are | name, GitHub handle, Jira email and account, git author, all per repo |
| §2 Paths | main checkout, worktrees, handoff and backup folders |
| §3 Permissions | the allowlist: every capability `yes`, `ask` or `no`, answered by you |
| §3b Cost and autonomy | budgets, concurrency, memory gates, dev-server port |
| §4 Tracker, tools and team | Jira (or `none`), work id patterns, required and advisory checks, merge holds, merge method, local review, toolchain commands, databases, staging, Vercel, Slack, people by role |
| §5 Conventions | branch and PR title format, PR body, AI attribution, ticket format, the repo's own instruction files |

### How values are written

Setup writes these for you; this is what to know when you read or edit the file by hand.

| Rule | Example |
|---|---|
| The value is what is in backticks; words outside them are notes | `` | Merge method | `squash` (all 20 recent PRs) | `` |
| A list has **one backtick span per item**, never comma-separated, so a name may contain a comma | `` | Required checks | `Lint, Type Check & Build` `Verify script sign-off` | `` |
| A command may name the folder it runs in, relative to the repo root. Never write `cd dir && …` | `` | Unit tests | `pnpm turbo run test` `backend: uv run pytest` | `` |
| `none` means the repo does not have that thing; the step is skipped and said so | `` | Staging | `none` | `` |
| `TODO` means not answered yet; a skill stops and asks rather than guess. In §3 it means `no` | `` | Designer | `TODO` | `` |
| §3 permissions are `yes` (standing), `ask` (ask each time) or `no` | `` | `pr-merge-green` | … | `ask` | `` |
| A merge hold is `<glob>: <why>`; a PR touching it is always left for you to merge | `` | Merge holds | `backend/**: build and push the Lambda images first` | `` |

"Green" means one thing everywhere: every required check succeeded on the exact commit (skipped
does not count), nothing else failed or is still running unless it is listed as advisory, and at
least one check succeeded. Merges are pinned to that commit.

### How the same rows differ between repos

The point of per-repo config, with examples of what setup found in real repos:

| Row | A pnpm monorepo on Vercel with Neon | A Python-first repo | A repo with no branch protection |
|---|---|---|---|
| §4 Tracker / Ticket key pattern | `jira` / `VPL-[0-9]+` | `jira` / `FW-[0-9]+` (keys in PR titles only) | `none` / `none` |
| §4 Other work id patterns | `P[0-9]+-M[0-9]+(-FIX)?-[0-9]+` | `none` (keyless branches are slugs) | `none` |
| §4 Required checks | `Verify script sign-off` `Lint, Type Check & Build` | `web-test` | `none` |
| §4 Advisory checks | `none` | `none` | `Lint code` `Run e2e tests` (red on every PR) |
| §4 Merge holds | `backend/**: build and push the Lambda images first` | `none` | `none` |
| §4 Unit tests | `pnpm turbo run test` | `apps/api: uv run pytest` `pnpm turbo run test` | `apps/api: uv run pytest` |
| §4 Local database | `none` (hosted Neon: workers get no database) | `none` (`apps/api/.env` points at production: blanked for workers) | `postgres container supastarter-postgres` |
| §5 AI attribution | `allowed` (commits carry Co-Authored-By) | `allowed` | `allowed` |

A repo whose history must stay free of AI attribution sets §5 AI attribution to `forbidden`; the
hook then refuses Claude trailers in that repo only.

## Checking a repo's setup

```bash
desk-env where                   # which repo and config apply here; EXISTS=yes once set up
desk-env get required-checks     # read any row by its id (desk-env ids lists them all)
desk-env list required-checks    # every item of a list row, one per line
desk-jira where                  # the Jira site, project and login this repo resolves to
```

**Before the first autopilot batch in a repo**, prove the worker sandbox on this machine. It starts
one short real `claude -p` with the generated worker settings and checks that the worker can edit
its own worktree and run every configured toolchain, and cannot touch the main checkout, stash, use
git aliases or write outside its worktree:

```bash
AUTOPILOT_PREFLIGHT=1 ~/.claude/desk/bin/spawn-worker.sh <TICKET> <worktree> preflight
```

The desk-skills test suite runs against throwaway homes and repos, never yours:

```bash
bash tests/run.sh
```

## Using autopilot

```
/desk-autopilot ABC-1005 ABC-1008 ABC-763
```

1. **Triage** reads each ticket (read-only) and flags anything it can't do alone.
2. **Plan** orders the batch so tickets touching the same files don't collide.
3. **Ask once**: every open question for the batch, in one go.
4. **Run**: one headless worker per ticket, each in its own worktree and port, limited to the
   permissions you granted in this repo. A worker gets its own database where the repo has a local
   one; otherwise its database variables are blanked, so no worker can reach a shared or production
   database.
5. **Merge**: if you allowed merging in this repo, each PR is merged with the repo's merge method
   once it is green at its head, pinned to that commit, one at a time. PRs touching a merge hold
   are always left for you. The recommended settings leave merging to you, so green PRs are
   reported instead.
6. **Park**: anything that needs a person waits, and you get a notification.

Run `/desk-autopilot` again to check progress, answer a parked question or resume. Batch state is
kept per repo, so two repos can run batches at once. Workers keep going if you close the session.

Workers are sandboxed: they start **without your own Claude Code settings** (`--setting-sources
""`), so a broad allow rule of yours never reaches them. A worker can push only its own branch, and
cannot merge, undraft, run git config or aliases, use `gh api`, or write outside its worktree.

## Updating

```bash
cd ~/desk-skills && git pull && ./install.sh
```

Restart Claude Code. Repo configs are kept; if the template gained rows, `/desk-setup` in that repo
asks only those. Re-run `./install.sh` after a Playwright plugin update, which undoes its patch.

## Changing things

- **A permission:** `/desk-setup permissions` in the repo. Revoking also removes the allow rules
  setup added there, and leaves any rules you wrote yourself.
- **Any other value:** re-run `/desk-setup` and say what to change, or edit the config file
  directly (`desk-env where` prints its path) following [How values are written](#how-values-are-written).
- **Every configured repo:** `/desk-setup list`.
- **Behaviour:** change it in this repo rather than in your installed copy; `install.sh` backs up
  local edits before replacing them. [`docs/porting-contract.md`](docs/porting-contract.md) has the
  rules that keep the skills generic, and [`docs/review-2026-09-27.md`](docs/review-2026-09-27.md)
  the adversarial review they were hardened against.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| A skill says there is no config for this repo | Run `/desk-setup` here. `desk-env where` shows the slug it looked up; a clone with no GitHub `origin` gets a `local__…` slug of its own |
| A skill stops on a `TODO` | That row was never answered; re-run `/desk-setup` in the repo |
| `desk-jira` says authentication failed | The token in the repo's folder is wrong or expired; rewrite `atlassian-token` (see [Jira login](#jira-login-per-repo)) |
| The autopilot preflight fails `ESCAPE` | The worker was not isolated from your own settings: reinstall (`./install.sh`) and re-run the preflight |
| Claude Code keeps asking before commands | Expected for anything you did not grant as `yes`; grant it per repo with `/desk-setup permissions` |
| A green PR is never merged by autopilot | It touches a §4 Merge holds path, has outstanding review feedback, or `pr-merge-green`/`autopilot-merge` is not `yes` |

## Origin

desk-skills began as a copy of studia-skills 2.3, with every company-specific fact moved into the
per-repo config. The workflow and its safety rails are unchanged, and were hardened by the review in
`docs/`.
