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
| `/desk-setup costs` | only where each repo is billed: which GitHub repos, Vercel teams and projects, AWS profiles and Neon orgs and projects bill which name, the Actions budget and any credit balance, in `~/.config/desk/costs.md` for the whole computer; changes nothing else. Read `references/mode-costs.md` |
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

## Steps

Steps 1 to 5 are in `references/`, beside this file. **At each step, read the file the table names
for it**, and only that one; the sections it names moved there word for word.

| Step | Sections | Read |
|---|---|---|
| 1. Detecting this repo, then confirming each config section with the user: the scan, the rows it proposes, and what to fix before the interview | *1. Detect, then confirm* | `references/step-1-detect.md` |
| 1, this computer: the machine profile, and how the §3b rows fall back to it | *This computer* | `references/step-1-this-computer.md` |
| 1, once §4 Pre-push checks is confirmed and is not `none`: committing the hook and setting `core.hooksPath` | *The pre-push hook* | `references/step-1-pre-push-hook.md` |
| 1, once §4 Local review command is `/desk-review`: committing the CI gate | *The desk gate workflow* | `references/step-1-desk-gate.md` |
| 2. The permission interview: how to ask the §3 rows, the autopilot warning, the consistency checks and what is not on offer | *2. The permission interview* | `references/step-2-interview.md` |
| 3. The connector checklist | *3. Connector checklist* | `references/step-3-connectors.md` |
| 4. Harness permissions: the deny-only plan, the allow plan, auto-mode entries, and `$H` and `REPO_RULES` for a revoke | *4. Harness permissions* | `references/step-4-harness.md` |
| 4b. Which plugins this repo needs, and `/desk-setup plugins` | *4b. Plugins this repo needs* | `references/step-4b-plugins.md` |
| 5. Writing the config, then showing every row | *5. Write it, then show every row* | `references/step-5-write.md` |

The §3b rounds, which step 1 proposes a default for and step 2 asks last, stay in this file
(*§3b: the autonomy rows*), as do *Re-running and revoking* and the red flags. A "§1" to "§5" or
"§4b" that names a step of setup (as in "§4 step 1") means that step's file; one that names a config
row means the config. An "above" or "below" a file does not hold is in the step the table names for
it.

**A reference file you cannot read stops setup.** If the file a step names is missing or empty, stop
and name it by its full path; never work the step from memory or an earlier copy of this skill.
`/desk-update` reinstalls it.

## §3b: the autonomy rows

Step 1 proposes the memory ceiling's default, and step 2 asks the §3b rows once its §3 rounds are
done. Both are here, read by every run that reaches them:

- **Memory ceiling** default: the machine profile's, else WSL `16`; otherwise physical RAM minus ~8.
  The profile's figure (`desk-env machine get memory-ceiling-gb`) is a hard limit across every repo:
  a row set above it reads as the machine's anyway. So when the row already holds a figure above the
  machine's, propose the machine's figure in its place and say why: "the machine profile limits
  every repo to <machine> GB (memory less 8 for the OS), and a repo
  row may be lower but never higher". A figure at or below the machine's stays as it is.

**Then §3b** (five rounds): subagents without asking, autopilot worker concurrency, memory ceiling,
spawn gate; test worker cap, preferred dev-server port, park-after minutes, per-worker budget; batch
budget, worker models, worker location, stage reports; push notification, check-in times, killed-worker
resumes (Recommended `2`: a pass resumes a worker a reboot or crash killed, in its own session, up to
that many times; `0` marks it failed instead), batches run by; orchestrator status table. For the
orchestrator status table, offer `full` (Recommended: the orchestrator session shows the whole
status table on every spawn and stage step, as it always has) and `quiet` (for anyone who keeps
desk-q open beside a batch run in the session: the status watch prints one line per ticket that
changed and the orchestrator answers a spawn or stage step in a line or less, so the session spends
fewer tokens; parks, questions, PRs, merges and failures are still reported, and the Stage 8 report
and any status you ask for carry the full table), and record the answer. For batches run by, run
`node ~/.claude/desk/bin/run-by.mjs offer` first. On macOS (`ask: true`) offer `supervisor`
(Recommended: once Stage 3 has asked, the supervisor runs the batch from launchd, the session ends,
and you follow it in desk-q, opening a session only when it needs you) and `session` (the batch runs
in the interactive session through `/loop`, as before). Off macOS (`ask: false`) don't ask: record
`session` and say its `line` in one sentence. Once the config is written with `supervisor`, run
`node ~/.claude/desk/bin/run-by.mjs ensure` in the repo, which installs and loads the supervisor, and
report its result; on exit 11 give its `error` and `retry` command, and leave the row at
`supervisor` (Stage 4 tries the install again). For
check-in times, Recommended is `08:00, 17:00`: questions and logged decisions from every repo arrive
together then, as one page and one push. For worker models, say that the row can also name a
`finder=<alias>` (`sonnet`, `haiku`) for self-review finders and a `text=<model>` for the Stage 7 PR and Jira session,
and that both are unset by default, so finders and that session run on the models they do today: a
cheaper model is set only after the eval harness (`desk/bin/skill-eval.mjs`) has run a review task
set on each model and the findings held. Never set either on the user's behalf. For worker location,
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
