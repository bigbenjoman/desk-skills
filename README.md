# desk-skills

Claude Code skills that take a ticket to a merged PR and a closed ticket, or work a batch of tickets
unattended. They are installed once per machine and **configured per repo**: each repository has
its own Jira (or none), email, people, commands, checks, conventions and permissions.

macOS, Linux and WSL.

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

## How per-repo configuration works

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

- The folder name is the repo's GitHub `owner__name`, read from `git remote get-url origin`. Every
  worktree of a repo finds the same config, so autopilot workers need no copying.
- Nothing is written into the repo itself except the Claude Code allow rules you grant, which go in
  the repo's `.claude/settings.local.json`. Claude Code keeps that file out of git.
- `desk-env where` shows which config applies in the current directory.
- A skill run in a repo with no config stops and offers `/desk-setup`. Values never carry over
  between repos unless you choose them again. Setup can *start* from another repo's answers to save
  typing, but you still confirm every one.

What lives in each repo's config (template: [`desk-config.md`](desk-config.md)):

| Section | Holds |
|---|---|
| §0 This repo | GitHub repo, default branch, a one-line description |
| §1 Who you are | name, GitHub handle, Jira email and account, git author, all per repo |
| §2 Paths | main checkout, worktrees, handoff and backup folders |
| §3 Permissions | the allowlist: every capability `yes`, `ask` or `no`, answered by you |
| §3b Autonomy | budgets, concurrency, memory gates, dev-server port |
| §4 Tracker, tools and team | Jira site/project/states/fields (or `none`), required checks, merge method, local review command, toolchain commands, databases, staging, Vercel, Slack, people by role |
| §5 Conventions | branch and PR title format, PR body, AI attribution, ticket format, the repo's own instruction files |

## Install

```bash
gh repo clone bigbenjoman/desk-skills ~/desk-skills
cd ~/desk-skills
./install.sh          # --check only reports; --yes accepts the prompts
```

The installer checks your tools, then:

- installs the skills, the autopilot scripts (`~/.claude/desk/bin`), `desk-env` and `desk-jira`
  (`~/.local/bin`), and a hook that blocks AI attribution **only in repos whose config forbids it**
- **asks first** before changing `~/.claude/settings.json` (registering the hook, adding the
  always-on deny rules), installing plugins (superpowers, codex, playwright, code-review,
  code-simplifier, frontend-design, vercel), replacing a `desk-jira` it didn't install, or patching
  the Playwright MCP
- never writes a repo config

Then **restart Claude Code, `cd` into a repo and run `/desk-setup`**. Repeat for each repo.

Some things are off whatever you answer: sending Slack messages (drafts only), merging past a repo's
required checks, and touching someone else's PR. `git push` never gets an allow rule, so Claude Code
asks before each push.

### Requirements

| Tool | Notes |
|---|---|
| Claude Code, `git`, `curl`, `jq`, `node`, `python3` | |
| `gh` | `gh auth login -s repo,workflow` |
| `codex` | optional: cross-vendor review. `brew install --cask codex` or `npm i -g @openai/codex`, then `codex login` |
| `mise` | only for repos that pin tools through it |
| `lsof` | preinstalled on macOS; `apt install lsof` on Linux |
| `flock` | optional; macOS `brew install flock`, otherwise a fallback lock is used |

`./install.sh --check` tells you what is missing.

### Jira, per repo

`desk-jira` is a fast Jira CLI the skills use instead of the Atlassian connector. It reads the Jira
site and project from the repo's config and the login from the files beside it, so two repos can
use two Atlassian sites with two accounts. `/desk-setup` walks you through it; by hand:

```bash
cd ~/some-repo
d="$(desk-jira where --dir)"; mkdir -p "$d" && chmod 700 "$d"
printf %s you@example.com > "$d/jira-email"
printf %s '<api token>' > "$d/atlassian-token" && chmod 600 "$d/atlassian-token"
desk-jira where && desk-jira whoami
```

Create the token at <https://id.atlassian.com/manage-profile/security/api-tokens>. A repo with no
Jira sets §4 Tracker to `none`; the ticket skills then work from a plain description.

## Using autopilot

```
/desk-autopilot ABC-1005 ABC-1008 ABC-763
```

1. **Triage** reads each ticket and flags anything it can't do alone.
2. **Plan** orders the batch so tickets touching the same files don't collide.
3. **Ask once**: every open question for the batch, in one go.
4. **Run**: one headless worker per ticket, each in its own worktree, port and (if the repo has one)
   database, limited to the permissions you granted in this repo.
5. **Merge**: if you allowed merging in this repo, each PR is merged with the repo's merge method
   once its required checks go green, one at a time. The recommended settings leave merging to you,
   so green PRs are reported instead.
6. **Park**: anything that needs a person waits, and you get a notification.

Run `/desk-autopilot` again to check progress, answer a parked question or resume. Batch state is
kept per repo, so two repos can run batches at once. Workers keep going if you close the session.
Their deny rules catch mistakes (a stray `--force`, pushing through `git -C`), not a deliberate
workaround; the skills themselves are what keep the work in bounds.

## Updating

```bash
git pull && ./install.sh
```

Restart Claude Code. Repo configs are kept; if the template gained rows, `/desk-setup` in that repo
asks only those. Re-run `./install.sh` after a Playwright plugin update, which undoes its patch.

## Changing things

- **Permissions:** re-run `/desk-setup permissions` in the repo. Revoking also removes the
  permission rules setup added there, and leaves any rules you wrote yourself.
- **See every configured repo:** `/desk-setup list`.
- **Behaviour:** change it here rather than in your installed copy. `install.sh` backs up local
  edits before replacing them. [`docs/porting-contract.md`](docs/porting-contract.md) has the rules
  that keep the skills generic.

## Origin

desk-skills began as a copy of studia-skills 2.3, with every company-specific fact moved into the
per-repo config. The workflow and its safety rails are unchanged.
