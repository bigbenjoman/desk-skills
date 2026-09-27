---
name: desk-setup
description: >-
  Use when setting up the studia-* skills for the first time or after ./install.sh, or when
  changing what they may do — "set up the studia skills", "configure studia", "run studia setup",
  "grant/revoke a studia permission", "let autopilot merge", "stop it merging", "why does it keep
  asking me", or when another studia-* skill reports that `~/.claude/desk-config.md` is missing,
  is on the 1.x layout, or has a TODO or missing row.
argument-hint: "[permissions]"
---

# desk-setup

## Overview

Fills in `~/.claude/desk-config.md` by asking, so the other skills know who the user is, where
things live, and **what they may do on the user's behalf**, including unattended.

**Core principle: every permission is granted out loud, by the person it belongs to, in this
conversation. Nothing is assumed, inherited, or inferred from a default.**

Each §3 row carries a **Recommended** value: the suggested starting point for the team. Most are
proven day-to-day practice; undrafting and merging are recommended at `ask`, so an engineer is
involved before `main`. Setup offers it as the first option, and the user still answers every row.
A row the user has not answered is a `no`.

## Never do these

- **Never write a permission the user did not choose in this conversation.** Recommended is the
  first option of the *question*, never the answer.
- **Never fill a value you merely guessed.** Detected-then-confirmed is fine; guessed is not.
- **Never change an existing config or settings file without a before/after**, and back up
  `~/.claude/settings.json` before touching it.
- **Never read a private source to decide whether you may read it.** Connector checks look for
  the tools; they never call one against content.
- **Never offer `yes` on a non-configurable row**, and never argue for a grant after a `no`.

| Excuse | Reality |
|---|---|
| "They took Recommended on the Jira rows, so the PR rows too" | Different capabilities, different answers. Ask each row. |
| "Recommended is the team default, so it's safe" | Safe for someone who chose it knowing the trade. That is what the question is for. |
| "Forty rows is tedious; I'll offer accept-all" | The user asked to be asked. Four per round, as many rounds as it takes. |
| "They didn't answer that one; leave it as recommended" | Unanswered is `no`. Say which rows you left off. |
| "I detected their GitHub handle, I can detect their permissions" | Facts can be detected. Consent cannot. |

## Modes

| Invocation | Does |
|---|---|
| `/desk-setup` | detect → interview → connectors → harness rules → write → summary |
| `/desk-setup permissions` | reads the config, then straight to the interview |
| config already exists | re-run: current values are the starting point; ask what to change |
| config on the 1.x layout (has `Work-log directory` or `Check-out channel`) | migrate: see *Migrating from 1.x* |

## 1. Detect, then confirm

Run these, then show one table (field · value · where it came from) and have the user correct it
in one round. Say before you start that the codex check makes one real request.

```bash
gh api user --jq .login
gh auth status -h github.com 2>&1 | sed -n 's/.*Token scopes: //p'        # needs repo + workflow
git config --global user.name; git config --global user.email
uname -s; grep -qi microsoft /proc/version 2>/dev/null && echo WSL
for d in ~/code/studia-web ~/studia-web ~/src/studia-web; do [ -e "$d/.git" ] && echo "$d"; done
git -C <repo> worktree list --porcelain | awk '/^worktree /{print $2}'   # infer the worktrees dir
desk-jira whoami                                                           # Jira display name, email, account id
(cd <repo> && codex exec --sandbox read-only "Reply with exactly: CODEX_OK")
claude plugin list --json | jq -r '.[] | "\(.id) enabled=\(.enabled)"'
jq '.hooks.PreToolUse' ~/.claude/settings.json | grep -c deny-ai-attribution
find <repo>/.claude/agents -maxdepth 1 -type l | wc -l
bash ~/.agents/skills/desk-setup/bin/user-skill-copies.sh <repo>        # user-level review-bar/pullbot copies
awk '/MemTotal/{printf "%.0f\n",$2/1048576}' /proc/meminfo 2>/dev/null || echo $(( $(sysctl -n hw.memsize) / 1073741824 ))
```

- **Handoff directory on WSL** must be Windows-visible. Find the Windows username with
  `cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r'` and propose
  `/mnt/c/Users/<name>/Downloads/`. Elsewhere `~/Downloads/`.
- **Jira account**: `desk-jira whoami`. If it is not configured, point at the README's `desk-jira`
  section; do not guess an account id.
- **codex**: only the exit code and a `CODEX_OK` in the output count. `codex login status` passes
  on a seat with no usage left.
- **Memory ceiling** default: WSL `16`; otherwise physical RAM minus ~8.
- **Write what detection found** into §4 once the user has seen the table: `desk-jira set up?`
  (`yes` only if `whoami` succeeded), `gh token scopes` (the scopes as printed) and `Codex answers
  a real call?` (`yes` with the date, or `no` with the error line).

Fix what detection finds before the interview, each as the user's own action:

| Finding | Tell them |
|---|---|
| `gh` lacks `workflow` | `! gh auth refresh -h github.com -s workflow` (updating a branch that touches workflows fails without it) |
| codex fails | `! codex login`, and pick the Studia team seat |
| plugins missing or hook unregistered | re-run `./install.sh` from the desk-skills checkout, then restart |
| `.claude/agents` has no links | offer to run `mise exec -- bun run agents:sync` in the repo (gitignored links; needed in every hand-made worktree) |
| a user-level `review-bar` or `pullbot` copy | show the script's output (path, source commit, how far behind) and ask them to remove it by hand: only studia-web's `.agents/skills` copy is supported. Never delete or refresh it for them |

## 2. The permission interview

`references/permission-rows.md` holds every row: the question, the Recommended option with what
it unlocks and what it exposes, the alternatives, and the harness rules it maps to. Read it now.

**How to ask:**

- `AskUserQuestion`, **one question per row, at most four per call**, in the rounds the reference
  lists. Run as many calls as it takes.
- **First option = the Recommended value, labelled `(Recommended)`.** Its description says what it
  unlocks *and* what it exposes. The alternatives are real choices, with their own trade-off.
- After each round, echo the four answers in one line before the next round.

**Before the autopilot round, say this plainly:** autopilot runs detached `claude -p` workers, one
per ticket, in their own worktrees. They edit code, push, open PRs, post to Jira and — with
`autopilot-merge` — merge on a green `🏁 CI gate`, **with nobody watching**. Anything they are not
granted, they park and ask about rather than guess. A worker never has more than the user's own
§3 grants.

**Consistency checks — ask again rather than writing a contradiction:**

| If | Then |
|---|---|
| `autopilot-workers` is `no` | write `no`/`none` for the other autopilot rows; say so, don't ask them |
| `pr-auto-merge` ≠ `pr-merge-green` | auto-merge merges on green by itself; ask which they meant |
| `autopilot-merge` is `yes` but `pr-merge-green` is not | a worker cannot exceed its user; ask again |
| `read-others` is `no` | the `read-own-work` harness rules are not written either (they read any PR or ticket); say so |
| `pr-edit` is `yes` but `pr-request-review` is not | `gh pr edit` gets no harness rule (it also adds reviewers); say so |
| `autopilot-merge` is `no` | `merge-driver.sh` gets no harness rule |
| `staging-write` | only `ask + backup + independent review` or `no` are offered |

**State what is not on offer**, so the absence reads as a decision: sending or scheduling a Slack
message; merging past the gate or plain `--force`; touching someone else's PR; deciding product,
design or catalog questions; committing legal or compliance content. Editing the file to `yes`
changes nothing. The deny-only plan (§4 step 1) is in `settings.json` whatever the answers.

**When a row's rule reaches further than its wording** (the reference's _Reach_ notes: `desk-jira
comment` posts on any ticket, `gh pr ready`/`comment`/`merge` on any PR), put that reach in the
Recommended option's description. For `git-push` say that Claude Code still prompts on each push:
no allow rule is written, because git's abbreviations (`-qf`, `--force-w`, `--delet`) mean no
pattern can fence every dangerous spelling. **When the user asks what a row
changes**, some rows only decide harness rules or are enforced by the skills' own rules: see
*Rows only setup reads* in the reference.

**Then §3b** (three rounds): subagents without asking, autopilot worker concurrency, memory ceiling
for parallel work, spawn gate; Jest cap, preferred dev-server port, park-after minutes, per-worker
budget; batch budget, report every stage transition on long runs, push notification when a batch
needs you. Then **§4** (two rounds): confirm or correct the code
reviewer, the Vercel, infra and security owner, the product owner, the designer; the QA filers and
who deletes Jira tickets. If the user *is* that person, write `you`. Then the staging bypass token
location: a path only, never ask for or write the token.

## 3. Connector checklist

Only for connectors a granted row depends on. **Check presence, never content**: look for the tool
in this session (`ToolSearch` with the keywords below). Do not call it.

| Connector | Needed by | Look for | If missing |
|---|---|---|---|
| Atlassian (claude.ai) | Jira rows when `desk-jira` fails; `read-confluence` | `getJiraIssue`, `getConfluencePage` | claude.ai → Settings → Connectors → Atlassian → Connect, then restart Claude Code signed in to the same account |
| Slack (claude.ai) | `slack-draft`, `read-slack-public`, `read-slack-own` | `slack_send_message_draft` | same path, Slack. The connector can also send; §4 denies those tools either way |
| Google Calendar and Gmail (claude.ai) | `read-calendar` | `list_events`, `search_threads` | same path, Google Calendar and Gmail |
| Figma (claude.ai) | `read-figma` | `get_design_context` | same path, Figma |
| Vercel (plugin) | `read-vercel` | `mcp__plugin_vercel_vercel__list_deployments` | `claude plugin install vercel@claude-plugins-official`, restart, `/mcp` to authenticate. CLI: `vercel login`, `vercel switch sophos-education-27386abb` |
| Playwright (plugin) | `pr-images`, screenshots | `browser_navigate` | re-run `./install.sh` (its Playwright step), restart. A `CONNECTION_CLOSED` at startup is the npx fault that step fixes |

`claude mcp list` shows server status; `/mcp` inside a session re-authenticates. Report each
connector as present, missing (with the step) or not needed.

## 4. Harness permissions

Offer to write Claude Code `permissions` rules to `~/.claude/settings.json` so granted actions stop
prompting. The rule column of `references/permission-rows.md` is the only source; read its syntax
table first. **The rules must never grant more than the answers: a prompt is always preferable to
an over-grant, so when in doubt, no allow rule.** Never hand-edit `settings.json` for this;
`bin/harness-rules.py` does the merge and the record.

```bash
H=~/.agents/skills/desk-setup/bin/harness-rules.py
```

1. **The deny-only plan first, before any allow is offered.** Run `python3 $H baseline --check`.
   Exit 0: `install.sh` already wrote it; say so. Exit 1: show the `missing` lines, say it only
   takes capability away (Slack send and write tools, `gh pr merge --admin`, best-effort force,
   delete and mirror pushes), then run `python3 $H baseline`, adding `--slack-prefix <prefix>` for
   any other Slack prefix the session shows. This is not a question and does not depend on the
   answers or the connector check. Exit 2: `settings.json` is unreadable; stop §4 and say so.
2. **Build the allow plan** (JSON; shape in the script's header):
   - an `add` entry for each rule whose **every** owner row is `yes`, `rows` = all its owners.
     `ask` and `no` rows add nothing to `allow`.
   - the row's `ask:` guards with the same owners; `unguard:` entries go in `remove_guards`,
     `rows` = the granting row.
3. **Show the plan** grouped by row, _Reach_ notes included, and get a yes.
4. Apply it, then refresh §3c:

```bash
python3 $H add "${TMPDIR:-/tmp}/studia-harness-plan.json"   # backs up settings.json and the ledger
python3 $H list --markdown                                   # replaces the §3c table
```

`add` and `baseline` print each rule as `NEW` (written and recorded), `recorded` (already setup's;
owners merged) or `yours` (the user already had it: never recorded, never removed), and each guard
as `UNGUARD`, `unguarded` (already removed; kept so) or left alone. Re-running a plan changes
nothing. Report the counts from that output, not from the plan.

Say plainly: a harness rule removes the prompt, not the skill's own gate. Where a rule reaches
further than its row, the skill's own ownership check is all that keeps it to the user's work.
Every close other than `jira-close-own-merged`'s, product calls and the stray-commit check still
stop. Autopilot workers never use these rules; they get their own settings file built from §3.

## 5. Write it, then show every row

Write `~/.claude/desk-config.md` from the template
`~/.agents/skills/desk-setup/references/desk-config.template.md` (`install.sh` copies the
checkout's `desk-config.md` there on every run), **keeping its structure, section numbers, row
keys and the Rules header**; skills cite rows by key. Then print every row with the user's own
answer in place of each `<answer>`:

```
STUDIA CONFIG WRITTEN — ~/.claude/desk-config.md

identity  : <name> · short <short form> · <github> · <jira email> · <jira display name> ·
            account <jira account id> · git <author> · pronouns <pronouns or they/them>
paths     : repo <path> · worktrees <path> · legacy portal <path or none> · handoff <path> · WSL <yes/no>
detected  : desk-jira <yes/no> · gh scopes <scopes> · codex <yes date / no>
reading   : own-work <answer> · local-git <answer> · others <answer> · slack-public <answer> ·
            figma <answer> · vercel <answer> · confluence <answer>
jira      : assign-self <answer> · comment <answer> · create <answer> · edit <answer> · transition <answer> ·
            close-own-merged <answer> · close <answer> · route <answer>
git / PR  : commit <answer> · push <answer> · force-with-lease <answer> · open <answer> · edit <answer> ·
            images <answer> · pullbot <answer> · reply <answer> · request-review <answer> · ready <answer> ·
            auto-merge <answer> · merge-green <answer> · update-branch <answer> ·
            conflict-unreviewed <answer> · conflict-reviewed <answer> · ci-rerun <answer> · codex <answer>
guards    : merge-feedback-first <answer> · jira-others <answer>
autopilot : workers <answer> · mode <answer> · merge <answer> · judgement <answer> · reclaim <answer>
local     : db-per-ticket <answer> · clone-staging <answer> · staging-write <answer> · reindex <answer> ·
            specs-it-shared <answer> · worktree-remove <answer> · branch-delete <answer> ·
            server-stop <answer> · skills-edit <answer> · vercel-env <answer> · slack-draft <answer>
never     : slack-send · merge-bypass · others-prs      stop: product-calls · legal-content
autonomy  : subagents <answer> · workers <answer> (cap <answer>) · memory <answer>GB · spawn gate <answer> ·
            Jest <answer> · port <answer> · park <answer>m · budget <answer>/<answer> ·
            stage reports <answer> · push notify <answer>
people    : reviewer <name> · Vercel/infra/security <name> · product <name> · designer <name> ·
            QA <names> · deletes tickets <name> · bypass token at <path>
connectors: Atlassian <present/missing/not needed> · Slack <…> · Figma <…> · Vercel <…> · Playwright <…>
harness   : deny-only plan <already there / n NEW> · <n> NEW allow · <n> ask · <n> guards removed ·
            <n> yours (untouched) · backup <path>
still TODO: <rows>
```

Every row appears, including the `no`s. Then say how to change it: re-run `/desk-setup`, or
`/desk-setup permissions`, or edit the file. No reinstall needed.

## Re-running and revoking

- **Read the existing config first**; show current values as the starting point.
- Ask what they want to change instead of re-interviewing. Diff the row keys of
  `~/.agents/skills/desk-setup/references/desk-config.template.md` (§3, §3b, §4) against the
  file: rows the template has that the file lacks are asked; nothing else is.
- Run §4 step 1 (the deny-only plan) on every re-run; it is a no-op when nothing is missing.
- **Before/after for every changed row**; never reset one quietly.
- Revoking is as easy as granting: set the row, run `python3 $H remove <row> [<row>...]` (it backs
  up, removes every rule any revoked row owns, and restores a guard that row had removed), refresh
  §3c from `list --markdown`, confirm. Do not argue for the capability it costs.
- A row newly `yes` on a re-run: `add` a plan with just its rules (and any `unguard:`).

## Migrating from 1.x

Carry §1 and the paths across (confirmed, not silently). Map old rows by meaning: Jira comment,
transition and create → `jira-comment`, `jira-transition`, `jira-create`; push, draft PR, PR body,
review reply, browser upload, force-with-lease → the matching `git-*` / `pr-*` rows; staging,
reindex, `specs-it/`, worktree, branch rows → the same-named local rows. Every row with no 1.x
equivalent (merge, feedback-first, undraft, auto-merge, update-branch, conflicts, CI rerun, codex, Done on
your own merge, all autopilot rows, Figma, Vercel, Slack draft) is asked. 1.x's Gmail, Calendar, Slack DMs and local
transcripts map to `read-calendar`, `read-slack-own` and `read-transcripts`. List what was dropped: Drive/Sheets,
work-log directory, check-out channel. 1.x's "never merge" does
not carry across; `pr-merge-green` is asked.

## Red flags — stop

- About to write a `yes` the user did not choose in this conversation
- Offering an accept-all instead of one question per row
- Filling a field from detection without showing it
- Calling a connector tool to "check" it
- Writing an `allow` rule for an `ask` or `no` row, or offering allows before the deny-only plan
  is in place
- Touching `settings.json` without a backup, or without recording the rules in §3c
- Merging permission rules by hand instead of through `harness-rules.py`, or recording a rule the
  user already had as setup's
- Explaining why they should grant something after they declined it
