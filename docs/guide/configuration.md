# Configuring a repo

> Part of the [desk-skills docs](README.md). Back to the [main README](../../README.md).

Each repo gets its own config: tracker, people, commands, checks, conventions and permissions. This page covers `/desk-setup`, the config file, and changing things later.

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
| 4b. Plugins | Works out from the repo's own files which installed plugins it does not need, and switches those off for this repo only. | Confirm the list |
| 5. Write | Writes the config and prints every row back. | Check the summary |

Re-running `/desk-setup` in a configured repo changes only what you ask to change. Its other forms
are listed under [This machine and this repo](skills.md#this-machine-and-this-repo).

## Jira login, per repo

Each repo's Jira login lives beside its config, so two repos can use two Atlassian sites or two
accounts. Setup prints these with the real folder filled in; you run them yourself:

```bash
d="$(desk-jira where --dir)"; mkdir -p "$d" && chmod 700 "$d"
printf %s you@example.com > "$d/jira-email" && chmod 600 "$d/jira-email"
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
    jira-email           your Atlassian login for this repo's Jira site (chmod 600)
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

What each section holds (template and full rules: [`desk-config.md`](../../desk-config.md)):

| Section | Holds |
|---|---|
| §0 This repo | GitHub repo, default branch, a one-line description |
| §1 Who you are | name, GitHub handle, Jira email and account, git author, all per repo |
| §2 Paths | main checkout, worktrees, handoff and backup folders |
| §3 Permissions | the allowlist: every capability `yes`, `ask` or `no`, answered by you |
| §3b Cost and autonomy | budgets, concurrency, memory gates, dev-server port |
| §4 Tracker, tools and team | Jira (or `none`), work id patterns, required and advisory checks, merge holds, merge method, local review command, review bar, review domain experts, clean review verdict, toolchain commands, databases, staging, Vercel, Slack, check-out destination, people by role |
| §5 Conventions | branch and PR title format, PR body, AI attribution, ticket format, the repo's own instruction files |

## How values are written

Setup writes these for you; this is what to know when you read or edit the file by hand.

| Rule | Example |
|---|---|
| The value is what is in backticks; words outside them are notes | `` | Merge method | `squash` (all 20 recent PRs) | `` |
| A list has **one backtick span per item**, never comma-separated, so a name may contain a comma | `` | Required checks | `Lint, Type Check & Build` `Verify script sign-off` | `` |
| A command may name the folder it runs in, relative to the repo root. Never write `cd dir && …` | `` | Unit tests | `pnpm turbo run test` `backend: uv run pytest` | `` |
| `none` means the repo does not have that thing; the step is skipped and said so | `` | Staging | `none` | `` |
| `TODO` means not answered yet; a skill stops and asks rather than guess. In §3 it means `no` | `` | Designer | `TODO` | `` |
| §3 permissions are `yes` (standing), `ask` (ask each time) or `no` | `` | `pr-merge-green` | … | `ask` | `` |
| A merge hold is `<glob>: <why>`, or `<glob>#<key>: <why>` to hold a JSON file only when that key changes; a PR into the default branch touching it is left for you to merge, unless the hold names its routine (`<why>; desk runs: <command>`) and §3 `merge-hold-routine` is `yes`, when the merge driver runs it and merges | `` | Merge holds | `backend/**: build and push the Lambda images first` | `` |

"Green" means one thing everywhere: every required check succeeded on the exact commit (skipped
does not count), nothing else failed or is still running unless it is listed as advisory, and at
least one check succeeded. Merges are pinned to that commit.

## How the same rows differ between repos

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
hook then refuses Claude trailers in that repo only, and autopilot workers there are not told to add one.

## Checking a repo's setup

```bash
desk-env where                   # which repo and config apply here; EXISTS=yes once set up
desk-env show [rules 3 5]        # the config's rules for the agent, headings and tables (never §3c)
desk-env get required-checks     # read any row by its id (desk-env ids lists them all)
desk-env list required-checks    # every item of a list row, one per line
desk-jira where                  # the Jira site, project and login this repo resolves to
```

## A second Claude login

desk runs every repo's work on this computer's default Claude login, unless a repo is pinned to
another. To add a login from the command line:

1. `CLAUDE_CONFIG_DIR=~/.claude-logins/<name> claude`, then `/login` with the other account, and quit.
2. `desk-env logins check` lists it with its account and plan once it is signed in.
3. `desk-env logins default claude <name>` makes it the default for every repo here, or
   `desk-env subscription set <repo slug> <email>` pins one repo to it (that repo's config §3b
   Subscription).

desk-q does the same in view 6: press `a` to add a login, then choose the default there.

## Changing things

- **A permission:** `/desk-setup permissions` in the repo. Revoking also removes the allow rules
  setup added there, and leaves any rules you wrote yourself.
- **Any other value:** re-run `/desk-setup` and say what to change, or edit the config file
  directly (`desk-env where` prints its path) following [How values are written](#how-values-are-written).
- **Every configured repo:** `/desk-setup list`.
- **Behaviour:** change it in this repo rather than in your installed copy; `install.sh` backs up
  local edits before replacing them. [`docs/porting-contract.md`](../porting-contract.md) has the
  rules that keep the skills generic, and [`docs/review-2026-09-27.md`](../review-2026-09-27.md)
  the adversarial review they were hardened against.
