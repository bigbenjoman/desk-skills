# desk-skills

Claude Code skills for Studia work: pick up an SV ticket and take it to a merged PR and a closed
Jira loop, or hand over a batch of tickets and let autopilot work them unattended.

Version 2.3 · 25 September 2026 · macOS, Linux and WSL

## Skills

| Skill | What it does | Start it with |
|---|---|---|
| `desk-setup` | Asks who you are and what the skills may do, then writes your config | `/desk-setup` |
| `desk-ticket` | One ticket, from triage to merged PR | `/desk-ticket SV-123` |
| `desk-autopilot` | A batch of tickets, one detached worker each, merged as each goes green | `/desk-autopilot SV-1 SV-2` |
| `desk-clearance` | Your open PRs: review comments, CI, branches behind `main`, merging | `/desk-clearance` |
| `desk-cleanup` | Stale worktrees and branches, Jira statuses that drifted from GitHub | `/desk-cleanup` |
| `desk-checkout` | Drafts your end-of-day `#agenda` Check Out from calendar, meeting notes, Jira, GitHub, Slack and Claude Code; never posts it | `/desk-checkout` |
| `desk-pr` | Opening or updating a PR, screenshots included | loads itself |
| `desk-jira` | Ticket comments, edits, transitions | loads itself |
| `desk-review-response` | Replying to and working a reviewer's comments | loads itself |
| `desk-dev` | Running the app locally against a copy of staging data | loads itself |

## Install

```bash
gh repo clone Sophos-Education/desk-skills
cd desk-skills
./install.sh          # --check only reports; --yes accepts the prompts
```

The installer checks your tools, then:

- installs the skills, the autopilot scripts (`~/.claude/desk/bin`) and a hook that blocks AI
  attribution in commits, PR bodies and Jira text
- creates `~/.claude/desk-config.md` if you don't have one (it never overwrites it)
- **asks first** before changing `~/.claude/settings.json` (registering the hook, turning off Claude
  Code's own attribution, adding the always-on deny rules), installing plugins (superpowers, codex,
  playwright, code-review, code-simplifier, frontend-design, vercel), replacing a `desk-jira` it
  didn't install, or patching the Playwright MCP

Then **restart Claude Code and run `/desk-setup`**. It confirms your details, then asks every
permission one at a time, saying what each one unlocks and exposes. The recommended answer is the
suggested starting point, with undrafting and merging left to you, but you choose, and anything
unanswered is a `no`. It can then add
Claude Code permission rules for what you granted, so those stop prompting.

Some things are off whatever you answer: sending Slack messages (drafts only), merging past the CI
gate, and touching someone else's PR. `git push` never gets an allow rule, so Claude Code asks
before each push.

### `review-bar` and `pullbot` come from studia-web only

The only supported copy of `review-bar` and `pullbot` is the one in studia-web's
`.agents/skills/`, which is what the `pullbot-gate` CI reviews against. A user-level copy under
`~/.agents/skills/` or `~/.claude/skills/` is a snapshot that falls behind and can load in its
place. `./install.sh` and `/desk-setup` name any they find, with the commit it came from and
how far behind it is, and ask you to remove it. They never delete or refresh it for you.

### Requirements

| Tool | Notes |
|---|---|
| Claude Code, `git`, `curl`, `jq`, `node`, `python3` | |
| `gh` | `gh auth login -s repo,workflow` |
| `mise` | provides bun and node for studia-web, which is bun-only |
| `codex` | `brew install --cask codex` (macOS) or `npm i -g @openai/codex`, then `codex login` |
| `lsof` | preinstalled on macOS; `apt install lsof` on Linux |
| `flock` | optional; macOS `brew install flock`, otherwise a fallback lock is used |
| studia-web checkout | `gh repo clone Sophos-Education/studia-web` |

`./install.sh --check` tells you what is missing.

### Jira token

`desk-jira` is a fast Jira CLI the skills use instead of the Atlassian connector.

```bash
mkdir -p ~/.config/studia
printf %s you@studia.io > ~/.config/studia/jira-email
printf %s '<api token>' > ~/.config/studia/atlassian-token && chmod 600 ~/.config/studia/atlassian-token
desk-jira whoami
```

Create the token at <https://id.atlassian.com/manage-profile/security/api-tokens>.

## Using autopilot

```
/desk-autopilot SV-1005 SV-1008 SV-763
```

1. **Triage** reads each ticket and flags anything it can't do alone.
2. **Plan** orders the batch so tickets touching the same files don't collide.
3. **Ask once**: every open question for the batch, in one go.
4. **Run**: one headless worker per ticket, each in its own worktree, port and database, limited to
   the permissions you granted.
5. **Merge**: if you allowed merging in setup, each PR is squash-merged when its CI gate goes green,
   one at a time. The recommended settings leave merging to you, so green PRs are reported instead.
6. **Park**: anything that needs a person waits, and you get a notification.

Run `/desk-autopilot` again to check progress, answer a parked question or resume. Workers keep
going if you close the session. Their deny rules catch mistakes (a stray `--force`, pushing through
`git -C`), not a deliberate workaround; the skills themselves are what keep the work in bounds.

## Updating

```bash
git pull && ./install.sh
```

Restart Claude Code. Your config is kept, and if new permissions were added, `/desk-setup` asks
only those. Re-run `./install.sh` after a Playwright plugin update, which undoes its patch.

## Changing things

- **Permissions:** re-run `/desk-setup permissions`. Revoking also removes the permission rules
  setup added, and leaves any rules you wrote yourself.
- **Behaviour:** open a PR here rather than editing your installed copy. `install.sh` backs up local
  edits before replacing them.
- **Problems:** macOS is the least tested platform. Report anything odd along with the command you
  ran.
