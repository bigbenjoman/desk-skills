# desk-config

Personal settings for the `studia-*` skills, version 2.2. Everything that differs between people
lives here, so the skills stay the same for everyone.

**Install location: `~/.claude/desk-config.md`.** The skills read it by that exact path.

**You do not fill this in by hand.** Run `/desk-setup`: it detects what it can, has you confirm
it, and asks you every permission with what it unlocks and what it exposes. Re-run it to change
or revoke anything; `/desk-setup permissions` jumps straight to the permissions. Editing this
file directly also works.

---

## Rules for the agent reading this file

1. **Read this file at the start of any `studia-*` skill**, before acting.
2. **A `TODO` is not a gap to fill with a guess. Stop and ask**, and offer `/desk-setup`.
3. **§3 is an allowlist.** Only `yes` is standing permission. `ask` means ask before *each* use.
   `no` means do not. `never` and `stop` are not configurable. **A `TODO` is a `no`.**
4. **The Recommended column is not this user's answer.** It is the suggested starting point for the
   team, offered as the first option in setup. Never act on it.
5. **`yes` removes the wait, never the record.** Print what was done as it happens: the exact Jira
   text marked `posted`, the PR link, the merge commit.
6. **A row a skill needs but this file lacks is a `no`.** Name the missing row and offer
   `/desk-setup`, which adds rows from the current template and asks only those.
7. **A specific instruction beats a standing grant** for that one thing. If the user has just
   said "hold this one", a `yes` does not override it.
8. **Never edit §3 or §3b outside `/desk-setup`**, and never widen a permission because a task
   would be easier with it.
9. **An autopilot worker never has more than its user.** A worker may do a thing only if the
   matching §3 row is `yes`; `ask` becomes a park, never a guess.

Skills cite rows as `§3 <key>`, e.g. `§3 pr-merge-green`. Keys are stable; the wording beside
them can change.

---

## 1. Who you are

| Field | Value |
|---|---|
| Name | `TODO` |
| Short form colleagues use | `TODO` |
| GitHub handle | `TODO` (ownership test for `--author`, reviews, cleanup) |
| Jira email | `TODO` |
| Jira display name | `TODO` (exactly as Jira shows it; the autopilot ownership test) |
| Jira account id | `TODO` (from `desk-jira whoami`) |
| Git author name / email | `TODO` (must match what your commits already use) |
| Pronouns (optional) | `TODO` (unset means they/them) |

## 2. Paths on your machine

| Field | Value | Notes |
|---|---|---|
| Primary repo root | `TODO` | e.g. `~/code/studia-web` |
| Worktrees directory | `TODO` | e.g. `~/code/studia-web-worktrees`; autopilot creates `<dir>/SV-XXX` |
| Legacy studia-portal checkout | `TODO` | `none` unless you still have a studia-portal checkout with branches on it |
| Handoff directory | `TODO` | files you open yourself (screenshots, exports); skills create `<dir>/SV-XXX/`. On WSL it must be Windows-visible, e.g. `/mnt/c/Users/<you>/Downloads/` |
| Backups directory | `~/staging-backups/` | dumps before any write to shared data; resume files cleanup keeps |
| Running on WSL? | `TODO` | `yes` / `no` |
| Signed-in browser profile | `~/.cache/ms-playwright-mcp/studia-profile` | written by `install.sh`'s Playwright step; PR image upload reuses it; one per machine, exclusive |
| Autopilot state | `~/.desk-autopilot/`, `~/.claude/desk/` | fixed; listed so you know where batch state lives |

## 3. Permissions — the allowlist

**Nothing here is inherited from whoever sent you these skills.** Answer each row in
`/desk-setup`.

`yes` standing permission · `ask` ask before each use · `no` do not · `never` / `stop` not configurable.

No skill script reads `read-*`, `git-commit` or `slack-draft`: they decide the §3c rules. The
skills' own rules enforce `autopilot-worker-mode`, `-judgement`, `-reclaim`, `db-per-ticket`,
`skills-edit`, `vercel-env`, the check-out's `read-transcripts`, `read-calendar` and
`read-slack-own`, and the not-configurable rows.

### Reading

| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| `read-own-work` | Your Jira issues, GitHub PRs, reviews and comments | `yes` | `TODO` |
| `read-local-git` | Local git across every worktree | `yes` | `TODO` |
| `read-others` | Other people's PRs and tickets, read-only | `yes` | `TODO` |
| `read-slack-public` | Public Slack channels you are in | `yes` | `TODO` |
| `read-figma` | Figma files linked from tickets (read-only tools) | `yes` | `TODO` |
| `read-vercel` | Vercel deployments, build and runtime logs | `yes` | `TODO` |
| `read-confluence` | Confluence pages | `ask` | `TODO` |
| `read-transcripts` | Your Claude Code session history (`~/.claude/projects`), for the check-out | `yes` | `TODO` |
| `read-calendar` | Your Google Calendar events and the Gemini meeting notes in your Gmail, for the check-out | `yes` | `TODO` |
| `read-slack-own` | Your own Slack messages in DMs and private channels, for the check-out | `ask` | `TODO` |

Declining `read-others` weakens the ownership guards: cleanup and clearance must read a PR to
know it is *not* yours.

### Jira

| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| `jira-assign-self` | Assign your ticket to yourself | `yes` | `TODO` |
| `jira-comment` | Post a comment on your own ticket | `yes` | `TODO` |
| `jira-create` | Create a ticket | `yes` | `TODO` |
| `jira-edit` | Edit your ticket's description or fields (Launch Priority, labels) | `yes` | `TODO` |
| `jira-transition` | Move your ticket between working states (In Development, Review/QA) | `yes` | `TODO` |
| `jira-close-own-merged` | Move your ticket to `Done` once your own last PR for it has merged | `yes` | `TODO` |
| `jira-close` | Close a ticket any other way (duplicate, not a bug, out of scope, already fixed) | `ask` | `TODO` |
| `jira-route` | Assign or route a ticket to another person | `ask` | `TODO` |
| `jira-others` | Comment on or transition someone else's ticket, or an unassigned one | `no` | `TODO` |

### Git and pull requests

| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| `git-commit` | Commit locally | `yes` | `TODO` |
| `git-push` | Push your own branch (no force) | `yes` | `TODO` |
| `git-force-with-lease` | Force-push your own branch with `--force-with-lease` | `ask` | `TODO` |
| `pr-open` | Open a draft PR | `yes` | `TODO` |
| `pr-edit` | Edit your PR's title or body | `yes` | `TODO` |
| `pr-images` | Drive a signed-in browser to upload PR screenshots | `yes` | `TODO` |
| `pr-self-review-comment` | Post `/pullbot` findings to your PR | `yes` | `TODO` |
| `pr-reply` | Reply to and resolve review threads on your PR | `yes` | `TODO` |
| `pr-request-review` | Request review, hand a PR back to its reviewer, add the infra/security owner (§4) | `yes` | `TODO` |
| `pr-ready` | Undraft your PR once its self-review is clean at head | `ask` | `TODO` |
| `pr-auto-merge` | Arm auto-merge (`gh pr merge --auto --squash`) | `ask` | `TODO` |
| `pr-merge-green` | Merge a PR once the CI gate is green (squash, no approval wait) | `ask` | `TODO` |
| `merge-feedback-first` | Work outstanding review feedback before merging | `yes` | `TODO` |
| `pr-update-branch` | Update your PR branch from `main` (`gh pr update-branch`) | `yes` | `TODO` |
| `pr-conflict-unreviewed` | Resolve a merge conflict on your PR before any human has reviewed it | `yes` | `TODO` |
| `pr-conflict-reviewed` | Resolve a merge conflict on your PR a reviewer has commented on | `ask` | `TODO` |
| `ci-rerun` | Re-run a completed CI run that was cancelled or hit a known flake | `yes` | `TODO` |
| `codex-review` | Send diffs to OpenAI Codex for cross-vendor refutation | `yes` | `TODO` |

`pr-auto-merge` merges on green by itself, so it needs `pr-merge-green` as well; setup asks again
if the two differ. `pr-merge-green` `no` means you merge: skills report a PR ready at `APPROVED` + green.
These three are recommended at `ask` because Protect Main requires 0 approvals: at `yes`, the agent's
own review verdict is the last check before `main`.

### Autopilot — unattended batches

| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| `autopilot-workers` | Run detached headless workers (`claude -p`) that work tickets while nobody watches | `yes` | `TODO` |
| `autopilot-worker-mode` | Worker permission mode | `dontAsk` + generated allow-list | `TODO` |
| `autopilot-merge` | Merge a worker's PR on green, serially, without you looking first | `no` | `TODO` |
| `autopilot-judgement` | Make and record an engineering or scope call instead of parking (product, catalog and other people's rulings still stop) | `yes` | `TODO` |
| `autopilot-reclaim` | Under memory pressure, kill an orphaned `next-server` or stale `tsc` (never a worker mid-commit, never another session's) | `yes` | `TODO` |

`autopilot-worker-mode` values: `dontAsk + generated allow-list` (Edit/Write scoped to the
worker's own worktree, every other worktree denied, toolchain allow-listed) or `none` (no workers).
`autopilot-merge` can be `yes` only if `pr-merge-green` is.

### Local and shared state

| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| `db-per-ticket` | Create a throwaway per-ticket local database | `yes` | `TODO` |
| `db-clone-staging` | Clone the staging database into local docker | `yes` | `TODO` |
| `staging-write` | Write to real staging | `ask` + backup + independent review | `TODO` (`ask` or `no` only) |
| `typesense-reindex` | Reindex local Typesense (collections are global, so every session's index) | `ask` | `TODO` |
| `specs-it-shared` | Run `specs-it/` against a database another session may be using | `no` | `TODO` |
| `worktree-remove` | Remove a worktree whose PR has merged | `ask` | `TODO` |
| `branch-delete` | Delete a local branch | `no` | `TODO` |
| `server-stop` | Stop a dev server you started for a finished ticket | `ask` | `TODO` |
| `skills-edit` | Edit your installed `studia-*` skill files | `ask` | `TODO` |
| `vercel-env` | Add or change a Vercel environment variable | `ask` | `TODO` |
| `slack-draft` | Save a Slack draft in your composer (never sent) | `yes` | `TODO` |

### Not configurable

| Key | Capability | Setting |
|---|---|---|
| `slack-send` | Send or schedule a Slack message as you | `never`: draft only, whatever the wording of the request |
| `merge-bypass` | Merge past the gate (`--admin`), or push with plain `--force` | `never` |
| `others-prs` | Push to, merge, undraft or close someone else's PR | `never` |
| `product-calls` | Decide a product, design or catalog question, or invent catalog data | `stop`: write the recommendation, label it pending the owner's sign-off (§4) |
| `legal-content` | Commit legal or compliance content changes | `stop`: findings first, as a Jira comment; implement after team sign-off |

These are not oversights. Editing them to `yes` changes nothing; the skills refuse independently.

## 3b. Cost and autonomy

| Field | Recommended | Your setting |
|---|---|---|
| Subagents that may run without asking | no cap | `TODO` (a number, or `no cap`) |
| Preferred dev-server port | `3000` | `TODO` (autopilot workers start at this port + 1) |
| Autopilot worker concurrency | `2 / 3` (default / cap) | `TODO` |
| Memory ceiling for parallel work (GB) | WSL: `16` · otherwise physical RAM minus ~8 | `TODO` (`DESK_CLEARANCE_MEM_GB` overrides) |
| Spawn gate (available memory) | start work > 8 GiB · hold 4–8 · drop to 1 below 4 | `TODO` |
| Jest `--maxWorkers` cap under the test lock | `4`, `2` while the spawn gate says hold | `TODO` |
| Autopilot per-worker budget (USD) | `25` (a runaway guard) | `TODO` (`none` turns it off) |
| Autopilot batch budget (USD) | `none` | `TODO` |
| Park an unanswered question after (minutes) | `15` | `TODO` |
| Report every stage transition on long runs | `yes` | `TODO` |
| Push notification when a batch needs you | `yes` | `TODO` |

Available memory is `MemAvailable` from `/proc/meminfo` on Linux and WSL, and
`(free + inactive + speculative) × page size` from `vm_stat` on macOS. On WSL the guest's `free -h`
overstates headroom; the ceiling above is the one that matters.

## 3c. Harness rules written by setup

`/desk-setup` adds Claude Code `permissions` rules to `~/.claude/settings.json` for your `yes`
rows, and deny rules for the `never` rows. It records only rules it added (never ones you had),
every row owning each, and any guard it removed. Revoking any owning row removes the rule.
Machine copy: `~/.claude/desk/harness-rules.json`, kept by `harness-rules.py`.

| Rule | List | Owning rows | Added |
|---|---|---|---|
| — | — | none yet | — |

---

## 4. Team and tools

Pre-filled for Studia. Setup confirms the people; correct anything that has moved on.

| Field | Value |
|---|---|
| Jira site | `studia-team-gdndoc1i.atlassian.net` (cloudId `c0c56c05-efc1-44e5-9e97-d636736fb82a`) |
| `desk-jira` set up? | `TODO` (`yes` / `no`; needs `JIRA_EMAIL` or `~/.config/studia/jira-email`, and a token at `~/.config/studia/atlassian-token`) |
| Jira project | `SV` ("Studia V2"), keys `SV-nnn`; issue types Task, Bug, Story |
| Workflow | `To Do → In Design → Dev Ready → In Development → Review/QA → Done` |
| Priority | built-in priority stays `Medium`; **Launch Priority** `customfield_10159` (P0–P4) is the ranking, mirrored by a `sev-pN` label |
| Other fields | Figma URL `customfield_10312`; resolve anything else with `desk-jira fields <filter>` |
| Labels | `qa-audit`, `studia-design-qa`, `design-system`, `needs-design`, `One-shot`, the `sev-pN` family |
| GitHub | org `Sophos-Education`; `studia-web` is the monorepo (`apps/portal`, `apps/studia-docs`, `apps/userflow`); `studia-portal` is wind-down |
| `main` protection | ruleset **Protect Main**: squash merges only; sole required check **`🏁 CI gate`**; 0 approvals required, but a standing `CHANGES_REQUESTED` blocks; branch need not be up to date; approvals are not dismissed on push; unresolved threads do not block. The legacy branch-protection endpoint 404s, so read `gh api repos/Sophos-Education/studia-web/rulesets` |
| `🏁 CI gate` needs | `pr-title`, `verify`, `portal-verify`, `portal-paths-guard`, `portal-deploy-dryrun`, `secrets`, `integration`, `sca`, `sast`, `pullbot-gate` (shown as `🌿 Local Adversarial Code Review`: the pullbot verdict at head), `preview`, `preview-build`. `🌿 PullBot (advisory)` is not required |
| Repo merge settings | squash commit title = PR title; auto-merge allowed; `delete_branch_on_merge: true` |
| `gh` token scopes | `TODO` (needs `repo` and `workflow`) |
| Codex answers a real call? | `TODO` (`codex exec`, never `codex login status`) |
| Package manager | **bun only**, pinned by mise from `.tool-versions`; agent shells use `mise exec -- bun`. npm, pnpm, yarn and npx are blocked |
| Staging | `next.studia.io`, behind Vercel Deployment Protection; get a bypass token from the Vercel owner, never commit it |
| Staging bypass token location | `TODO` (a file only you read, e.g. `~/.config/studia/vercel-staging-bypass`: the path, never the token) |
| Vercel | team `sophos-education-27386abb`; projects studia-web `prj_W030WjX16zMgyLMP516gtdbxFwUo`, studia-docs `prj_nZAIzx8Cq68hlX7wDzL1ZkhWzyKS`, journeys `prj_Ih0vTbUOpq5e0AWMYxSE4qPfWoEq` |
| Slack channels | `#tech`, `#testing`, `#studia-team` |
| Local infra | Postgres in docker (`studia-web-postgres-1`, :5432), Typesense :8108, Mailpit; dev server :3000 |
| Project subagents | `.claude/agents/` holds gitignored links; a fresh worktree needs `bun run agents:sync` or `/pullbot`'s named reviewers run as general-purpose |

### People, by role

If you are one of these people, setup writes `you` in that row.

| Role | Currently | Confirmed |
|---|---|---|
| Code reviewer | Chris Anthony (GitHub `mousedown`) | `TODO` |
| Vercel, infra and security owner; repo admin | Chris Anthony (`mousedown`): add as reviewer on security PRs; tell on infra PRs (`packages/studia-web/infrastructure/**`, CDK stacks, `packages/{chat,crm,moderation,shared-infrastructure*}`, `.github/workflows/**`); issues the staging bypass token and `.env.staging`; Neon access | `TODO` |
| Product owner | Ben Lavender (product, catalog, scope); Chris Anthony for process calls | `TODO` |
| Designer | Joni: `needs-design` tickets | `TODO` |
| QA filers | Shan Shanmuhanathan (most bug tickets), Joni (design-QA): repro steps are observed, not alleged | `TODO` |
| Deletes Jira tickets | Ben Lavender | `TODO` |
| No longer at Studia | Blake Simpson: don't route work to them | — |

### What review here consistently asks for

Most PRs are approved. This is the house bar, mined from past review history; only the first and
last rows come from the current reviewer directly.

| Ask | Detail |
|---|---|
| Fewer moving parts | justify new infrastructure; prefer existing plumbing over a new stack |
| Short comments | default none; at most one short human line (a verbose-comment PR was rejected) |
| Specs for new helpers and regexes | a missing spec was the other rejection on record |
| Before/after screenshots | on UI changes; two or three widths, not every breakpoint |
| No hardcoded values | where an env var already exists |
| No one-off scripts or unrelated changes | removed before merge |
| Reuse the design system | promote a component shared by two surfaces into `src/components/studia/` |
| Local review first | run `/pullbot` before opening, and post the clean sweep |

## 5. Conventions

House style from the Studia repos; most people leave these alone.

| Field | Value |
|---|---|
| Branch names | `<type>/SV-123-short-slug`: `fix/` Bug, `feat/` Task and Story, `chore/` data-only. Uppercase key. Never `bugfix/`; `feature/` is legacy |
| PR title | `type(scope): SV-123 short description`; types `feat fix chore ci docs test refactor perf build style revert`, `!` before the colon if breaking; key uppercase, straight after the colon; lowercase optional scope; multi-part `SV-512 (1/2)`; ticketless work takes the `no-jira` label. CI-gated, and **only a push re-runs the check**, not a retitle |
| AI attribution | forbidden in commits, PR bodies, Jira and replies: no `Co-Authored-By: Claude`, `Claude-Session:`, "Generated with Claude Code" or robot emoji. `install.sh` offers to blank Claude Code's `attribution` setting; its hook denies these in `git commit` messages (`-m`, `-F`), `gh pr create/edit/comment/review` and `gh api graphql` bodies (`--body-file` too) and `desk-jira` comment/create/edit text. Slack drafts and stdin bodies are unchecked |
| PR body | intro paragraph · `### Changes` · `### Testing` (evidential: numbers, paths, names) · optional `### Not migrated` (each remaining site as `path#symbol`, one line on why it was left) · optional `### Before / after`. No `##` title. Ordinary technical English; em dashes are fine here |
| PR lifecycle | draft → `/pullbot` loop, at most three rounds, until a full sweep is clean → post that sweep → undraft only at `p0=0 p1=0 p2=0 deferred=0 gaps=0` and not `DIRTY` → `--auto --squash` → shepherd to merge. Fix confirmed findings in the same PR; stop and ask when a fix needs a new file or one outside the diff. Moving equivalent sites onto a helper this PR creates or fixes is not growth. Migrate them all, or list each one under *Not migrated* in the PR body. Growth means new behaviour, not new call sites. Changed verdict counts need a new run |
| Batches | serial to the merge: each PR merges as soon as it is green; a ticket sharing files starts once its predecessor merges |
| Jira ticket format | `[Area]` summary; `## Summary`, `Environment`, `Steps to reproduce`, `Expected vs Actual`, `Diagnosis (code)`, `Acceptance criteria` (Given/When/Then), `References` |
| Jira comment | root cause in one sentence, fix in one sentence, PR link; skip it if a comment already carries the link |
| Code comments | default none; at most one short line |
| User-facing copy you write | no em dashes or similar flourishes; copy supplied by design or product ships verbatim |
| Messages to colleagues | plain, direct, British spelling, no emoji, no filler ("shout if", "no rush", "worth checking"): the fact, then the ask. Always a draft |
| Decisions put to you | one `AskUserQuestion` carousel, recommended option first and labelled, trade-off on each option |
| Vercel env vars | leave Sensitive unticked (`--no-sensitive`); pass the value on stdin |
