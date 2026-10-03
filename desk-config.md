# desk-config

Settings for the `desk-*` skills **in one repository**, version 1.0. Every repo you use desk in has
its own copy, so Jira, email, people, commands, conventions and permissions can all differ between
repos. The skills themselves are the same everywhere.

**Install location: `~/.config/desk/repos/<slug>/config.md`**, where `<slug>` is the repo's GitHub
`owner__name` from `git remote get-url origin` (e.g. `bigbenjoman__voicepa`). The skills find it from
whatever directory they run in, so every worktree of a repo shares one config. It never lives inside
the repo, so nothing here reaches git. `DESK_CONFIG=/path/to/config.md` overrides the lookup.
`desk-env where` prints the slug, the config path and the credentials folder for the current
directory.

Credentials sit beside it and are only ever referenced by path:
`~/.config/desk/repos/<slug>/jira-email`, `atlassian-token` (chmod 600), and anything §4 names.

**You do not fill this in by hand.** Run `/desk-setup` inside the repo: it detects what it can, has
you confirm it, and asks every permission. It can start from another repo's answers so a second repo
is quick. Re-run it to change or revoke anything; `/desk-setup permissions` jumps straight to the
permissions. Editing this file directly also works.

---

## Rules for the agent reading this file

1. **Read this repo's config at the start of any `desk-*` skill**, before acting. Resolve it with
   `desk-env where`; never assume another repo's values apply here.
2. **No config for this repo means stop.** Say which slug was looked up and offer `/desk-setup`.
3. **A `TODO` is not a gap to fill with a guess. Stop and ask**, and offer `/desk-setup`.
4. **§3 is an allowlist.** Only `yes` is standing permission. `ask` means ask before *each* use.
   `no` means do not. `never` and `stop` are not configurable. **A `TODO` is a `no`.**
5. **The Recommended column is not this user's answer.** It is the suggested starting point, offered
   as the first option in setup. Never act on it.
6. **`yes` removes the wait, never the record.** Print what was done as it happens: the exact Jira
   text marked `posted`, the PR link, the merge commit.
7. **A row a skill needs but this file lacks is a `no`** (or, outside §3, unset). Name the missing
   row and offer `/desk-setup`, which adds rows from the current template and asks only those.
8. **`none` is an answer.** A §4 row set to `none` means this repo does not have that thing (no
   Jira, no staging, no designer). Skip the step that needs it and say so; do not improvise one.
9. **A specific instruction beats a standing grant** for that one thing.
10. **Never edit §3 or §3b outside `/desk-setup`**, and never widen a permission because a task
    would be easier with it.
11. **An autopilot worker never has more than its user.** A worker may do a thing only if the
    matching §3 row is `yes`; `ask` becomes a park, never a guess.

Skills cite rows as `§3 <key>`, e.g. `§3 pr-merge-green`, and other rows by section and name, e.g.
`§4 Ticket key pattern`. Keys and row names are stable; the wording beside them can change.

**How a value is written.** The value is what sits in backticks. A row that holds a list (checks,
env files, commands, projects) takes **one backtick span per item**, e.g.
`` `Lint, Type Check & Build` `Verify script sign-off` ``: items are never split on commas, so a
name may contain one. A `|` inside backticks is part of the value. Words outside backticks are notes
for people and are ignored by the scripts. A **command** item may name the directory it runs in,
relative to the repo root, as `` `apps/api: uv run pytest` ``; never write `cd dir && …`, which
breaks the test lock and the worker allow-list.

**"Green" means one thing everywhere** (merge driver, clearance, ticket, autopilot): on the exact
head commit being merged, every §4 Required check completed with success (skipped does not count);
no other check failed, errored, timed out or is still queued or running, unless §4 Advisory checks
names it; and at least one check completed with success. The merge is then pinned to that commit
(`--match-head-commit`), so a push after the check cannot be merged unchecked.

---

## 0. This repo

| Field | Value |
|---|---|
| GitHub repo | `TODO` (`owner/name`, from the origin remote) |
| Slug | `TODO` (`owner__name`; the folder this file lives in) |
| Default branch | `TODO` (e.g. `main`) |
| One-line description | `TODO` (what the product is; used to brief subagents) |

## 1. Who you are in this repo

Per repo, because the email, Jira account and even the GitHub handle can differ between clients.

| Field | Value |
|---|---|
| Name | `TODO` |
| Short form colleagues use | `TODO` |
| GitHub handle | `TODO` (ownership test for `--author`, reviews, cleanup) |
| Jira email | `TODO` (`none` if §4 Tracker is `none`) |
| Jira display name | `TODO` (exactly as Jira shows it; the autopilot ownership test) |
| Jira account id | `TODO` (from `desk-jira whoami`) |
| Git author name / email | `TODO` (must match what your commits in this repo already use) |
| Pronouns (optional) | `TODO` (unset means they/them) |

## 2. Paths on your machine

| Field | Value | Notes |
|---|---|---|
| Primary repo root | `TODO` | the main checkout, e.g. `~/voicepa` |
| Worktrees directory | `TODO` | e.g. `~/voicepa-worktrees`; autopilot creates `<dir>/<TICKET>` |
| Handoff directory | `TODO` | files you open yourself (screenshots, exports); skills create `<dir>/<TICKET>/`. On WSL it must be Windows-visible |
| Backups directory | `~/desk-backups/<slug>/` | dumps before any write to shared data |
| Running on WSL? | `TODO` | `yes` / `no` |
| Signed-in browser profile | `~/.cache/ms-playwright-mcp/desk-profile` | written by `install.sh`'s Playwright step; PR image upload reuses it; one per machine, exclusive |
| Autopilot state | `~/.desk-autopilot/<slug>/`, `~/.claude/desk/` | fixed; listed so you know where batch state lives |

## 3. Permissions — the allowlist

**Nothing here is inherited from another repo or another person.** Answer each row in
`/desk-setup` (which may offer another repo's answers as the starting point; you still confirm).

`yes` standing permission · `ask` ask before each use · `no` do not · `never` / `stop` not configurable.

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
| `read-calendar` | Your Google Calendar events and meeting notes in your Gmail, for the check-out | `yes` | `TODO` |
| `read-slack-own` | Your own Slack messages in DMs and private channels, for the check-out | `ask` | `TODO` |

Declining `read-others` weakens the ownership guards: cleanup and clearance must read a PR to
know it is *not* yours.

### Jira

Skip the whole round (write `no`) when §4 Tracker is `none`.

| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| `jira-assign-self` | Assign your ticket to yourself | `yes` | `TODO` |
| `jira-comment` | Post a comment on your own ticket | `yes` | `TODO` |
| `jira-create` | Create a ticket | `yes` | `TODO` |
| `jira-edit` | Edit your ticket's description or fields (priority field, labels), and Blocks links (`desk-jira link`, never a worker's) | `yes` | `TODO` |
| `jira-transition` | Move your ticket between working states (§4 In-progress state, Review state) | `yes` | `TODO` |
| `jira-close-own-merged` | Move your ticket to §4 Done state once your own last PR for it has merged | `yes` | `TODO` |
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
| `pr-self-review-comment` | Post the §4 Local review command's findings to your PR | `yes` | `TODO` |
| `pr-review-others` | Post a `/desk-review` review (`COMMENTED`, never approve or request changes) on someone else's PR | `ask` | `TODO` |
| `pr-reply` | Reply to and resolve review threads on your PR | `yes` | `TODO` |
| `pr-request-review` | Request review, hand a PR back to its reviewer, add the infra/security owner (§4) | `yes` | `TODO` |
| `pr-ready` | Undraft your PR once its self-review is clean at head | `ask` | `TODO` |
| `pr-auto-merge` | Arm auto-merge (`gh pr merge --auto`), where the repo allows it | `ask` | `TODO` |
| `pr-merge-green` | Merge a PR once §4 Required checks are green (no approval wait) | `ask` | `TODO` |
| `merge-feedback-first` | Work outstanding review feedback before merging | `yes` | `TODO` |
| `pr-update-branch` | Update your PR branch from the default branch (`gh pr update-branch`) | `yes` | `TODO` |
| `pr-conflict-unreviewed` | Resolve a merge conflict on your PR before any human has reviewed it | `yes` | `TODO` |
| `pr-conflict-reviewed` | Resolve a merge conflict on your PR a reviewer has commented on | `ask` | `TODO` |
| `ci-rerun` | Re-run a completed CI run that was cancelled or hit a known flake | `yes` | `TODO` |
| `codex-review` | Send diffs to OpenAI Codex for cross-vendor refutation | `yes` | `TODO` |

`pr-auto-merge` merges on green by itself, so it needs `pr-merge-green` as well; setup asks again
if the two differ. `pr-merge-green` `no` means you merge: skills report a PR ready at `APPROVED` +
green. Undrafting and merging are recommended at `ask`: where §4 Branch protection requires no
approvals, the agent's own review verdict is otherwise the last check before the default branch.

### Autopilot — unattended batches

| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| `autopilot-workers` | Run detached headless workers (`claude -p`) that work tickets while nobody watches | `yes` | `TODO` |
| `autopilot-worker-mode` | Worker permission mode | `dontAsk` + generated allow-list | `TODO` |
| `autopilot-merge` | Merge a worker's PR on green, serially, without you looking first | `no` | `TODO` |
| `autopilot-judgement` | Make and record an engineering or scope call instead of parking (product and other people's rulings still stop) | `yes` | `TODO` |
| `autopilot-reclaim` | Under memory pressure, kill an orphaned dev server or stale typecheck (never a worker mid-commit, never another session's) | `yes` | `TODO` |

`autopilot-worker-mode` values: `dontAsk + generated allow-list` (workers are launched with
`--setting-sources ""`, so your own Claude Code settings, including any broad `Bash(*)` allow, never
reach them; file access is Edit rules scoped to the
worker's own worktree, every other worktree denied, toolchain allow-listed) or `none` (no workers).
`autopilot-merge` can be `yes` only if `pr-merge-green` is.

### Local and shared state

| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| `db-per-ticket` | Create a throwaway per-ticket local database (needs §4 Local database) | `yes` | `TODO` |
| `db-clone-staging` | Clone the staging database into a local container | `yes` | `TODO` |
| `staging-write` | Write to real staging | `ask` + backup + independent review | `TODO` (`ask` or `no` only) |
| `local-reindex` | Rebuild a shared local index or cache that every session uses (§4 Local services) | `ask` | `TODO` |
| `tests-shared-db` | Run database-backed tests against a database another session may be using | `no` | `TODO` |
| `worktree-remove` | Remove a worktree whose PR has merged | `ask` | `TODO` |
| `branch-delete` | Delete a local branch | `no` | `TODO` |
| `server-stop` | Stop a dev server you started for a finished ticket | `ask` | `TODO` |
| `skills-edit` | Edit your installed `desk-*` skill files | `ask` | `TODO` |
| `vercel-env` | Add or change a Vercel environment variable | `ask` | `TODO` |
| `slack-draft` | Save a Slack draft in your composer (never sent) | `yes` | `TODO` |

### Not configurable

| Key | Capability | Setting |
|---|---|---|
| `slack-send` | Send or schedule a Slack message as you | `never`: draft only, whatever the wording of the request |
| `merge-bypass` | Merge past required checks (`--admin`), or push with plain `--force` | `never` |
| `others-prs` | Push to, merge, undraft or close someone else's PR | `never` |
| `product-calls` | Decide a product, design or content question, or invent product data | `stop`: write the recommendation, label it pending the owner's sign-off (§4) |
| `legal-content` | Commit legal or compliance content changes | `stop`: findings first, as a ticket comment; implement after sign-off |

These are not oversights. Editing them to `yes` changes nothing; the skills refuse independently.

## 3b. Cost and autonomy

| Field | Recommended | Your setting |
|---|---|---|
| Subagents that may run without asking | no cap | `TODO` (a number, or `no cap`) |
| Preferred dev-server port | `3000` | `TODO` (autopilot workers start at this port + 1) |
| Autopilot worker concurrency | `2 / 3` (default / cap) | `TODO` |
| Memory ceiling for parallel work (GB) | WSL: `16` · otherwise physical RAM minus ~8 | `TODO` (`DESK_CLEARANCE_MEM_GB` overrides) |
| Spawn gate (available memory) | start work > 8 GiB · hold 4–8 · drop to 1 below 4 | `TODO` |
| Test worker cap under the test lock | `4`, `2` while the spawn gate says hold | `TODO` |
| Autopilot per-worker budget (USD) | `25` (a runaway guard) | `TODO` (`none` turns it off) |
| Autopilot batch budget (USD) | `none` | `TODO` |
| Park an unanswered question after (minutes) | `15` | `TODO` |
| Report every stage transition on long runs | `yes` | `TODO` |
| Push notification when a batch needs you | `yes` | `TODO` |

## 3c. Harness rules written by setup

`/desk-setup` adds Claude Code `permissions` allow rules for your `yes` rows to **this repo's**
`<Primary repo root>/.claude/settings.local.json` (it must be gitignored; setup checks, and copies it into worktrees you create yourself, but
**never** into an autopilot worker's worktree: workers get their own rules built from §3), so a grant in one repo never reaches another. The always-on
deny rules for the `never` rows live in `~/.claude/settings.json`, because they only take capability
away. Setup records only rules it added (never ones you had), every row owning each, and any guard it
removed. Revoking any owning row removes the rule. Machine copy:
`~/.config/desk/repos/<slug>/harness-rules.json`, kept by `harness-rules.py`.

| Rule | List | Owning rows | Added |
|---|---|---|---|
| — | — | none yet | — |

---

## 4. Tracker, tools and team

Detected by setup from the repo, GitHub and Jira, then confirmed. `none` means this repo has no
such thing.

### Tracker

| Field | Value |
|---|---|
| Tracker | `TODO` (`jira` or `none`; with `none`, tickets are plain descriptions and the Jira steps are skipped) |
| Jira site | `TODO` (e.g. `yourteam.atlassian.net`) |
| Jira cloudId | `TODO` (for the Atlassian connector fallback) |
| Jira project | `TODO` (key and name, e.g. `KAN` "Voice PA"; issue types) |
| Ticket key pattern | `TODO` (a regex for this tracker's keys, e.g. `KAN-[0-9]+`; `none` with Tracker `none`) |
| Other work id patterns | `TODO` (regexes for ids work is also named by that are NOT tracker keys, one span each, e.g. planning-tool ids `P[0-9]+-M[0-9]+(-FIX)?-[0-9]+` or `BUG-[0-9]+(-[0-9]+)*`; or `none`. Such an id is accepted as a ticket, and its text comes from a ticket file the skill writes, never from Jira) |
| Workflow | `TODO` (the states in order, e.g. `To Do → In Progress → In Review → Done`) |
| In-progress state | `TODO` (what `jira-transition` moves to when work starts) |
| Review state | `TODO` (what it moves to when the PR is open; `none` to skip) |
| Done state | `TODO` (what `jira-close-own-merged` moves to) |
| Priority | `TODO` (built-in priority, or a custom field id and its values) |
| Other fields | `TODO` (e.g. a Figma URL field id; `desk-jira fields <filter>` resolves the rest) |
| Labels | `TODO` (labels the skills may apply, or `any`) |
| `desk-jira` set up? | `TODO` (`yes` / `no`; reads the email and token in this repo's credentials folder) |

### GitHub and CI

| Field | Value |
|---|---|
| Branch protection | `TODO` (as detected: required approvals, whether a standing `CHANGES_REQUESTED` blocks, whether the branch must be up to date; `none` if unprotected) |
| Required checks | `TODO` (the check names that must succeed to merge, one span each, exactly as GitHub shows them; from branch protection AND rulesets. `none` only when nothing is required, and then "Green" still requires every non-advisory check to pass) |
| Advisory checks | `TODO` (checks that may fail without blocking a merge, one span each, e.g. a check that is red on the default branch too; or `none`. Every other check that runs must pass: see "Green" above) |
| Merge holds | `TODO` (paths a PR may touch only with a person merging it, each as `` `<glob>: <why>` ``, e.g. `` `backend/**: build and push Lambda images first (./scripts/build-lambda-images-local.sh)` ``; or `none`. Autopilot and clearance never merge such a PR themselves; they report it with the reason) |
| Merge method | `TODO` (`squash`, `merge` or `rebase`; what the skills pass to `gh pr merge`) |
| Repo merge settings | `TODO` (auto-merge allowed? `delete_branch_on_merge`?) |
| `gh` token scopes | `TODO` (needs `repo` and `workflow`) |
| Codex answers a real call? | `TODO` (`codex exec`, never `codex login status`) |
| Local review command | `TODO` (run before opening a PR and posted with `pr-self-review-comment`: `/desk-review`, a review skill the repo ships, `/code-review`; `none` to skip) |
| Clean review verdict | `TODO` (how the local review says clean: for `/desk-review`, `p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0`; or e.g. `no findings`) |
| Review bar | `TODO` (`default` for desk-review's built-in bar, or the repo path of this repo's own, e.g. `docs/review-bar.md`) |
| Review domain experts | `TODO` (skills a `/desk-review` finder loads for matching paths, one span each as `` `<glob>: <skill>` ``, e.g. `` `apps/api/pricing/**: energy-trader` ``; or `none`) |
| Project subagents sync | `TODO` (command a fresh worktree needs to link `.claude/agents`, or `none`) |

### Toolchain

| Field | Value |
|---|---|
| Package manager | `TODO` (e.g. `pnpm`; name any that are forbidden) |
| Command prefix | `TODO` (what agent shells put in front, e.g. `mise exec --`, or `none`) |
| Install | `TODO` (e.g. `pnpm install --frozen-lockfile`) |
| Dev server | `TODO` (one span per app, e.g. `` `pnpm --filter frontend dev` `portal: pnpm dev` ``; say whether each honours `PORT` or hard-codes a port, since workers are given ports from §3b's port + 1 upwards) |
| Typecheck | `TODO` |
| Lint | `TODO` |
| Unit tests | `TODO` (one span per suite, e.g. `` `pnpm turbo run test` `apps/api: uv run pytest` ``; note how to run one file) |
| E2E tests | `TODO` (or `none`) |
| Integration tests | `TODO` (database-backed suite, and whether it needs its own database; or `none`) |
| Build | `TODO` |
| Env files | `TODO` (the `.env*` files a new worktree needs copied from the primary checkout, one span each, e.g. `` `frontend/.env.local` `portal/.env.local` ``; or `none`) |

### Environments and services

| Field | Value |
|---|---|
| Local database | `TODO` (a local Postgres that per-ticket databases can be created in, as `` `postgres container <name>` ``, e.g. `` `postgres container voicepa-postgres-1` ``; or `none` when the app uses a hosted database such as Neon. `none` means workers get no database at all) |
| Database URL variable | `TODO` (every env var that holds a database URL or name, one span each, e.g. `` `DATABASE_URL` `DATABASE_URL_UNPOOLED` ``; or `none`. In a worker's worktree each one is repointed at its own per-ticket database or, when none was provisioned, blanked, so no worker can reach a shared, staging or production database) |
| Database migrate | `TODO` (command that brings a fresh database up to schema, e.g. `pnpm db:migrate`; or `none`) |
| Seed | `TODO` (command that loads local data into a fresh database, or `none`) |
| Local services | `TODO` (search, mail catcher, queues, with ports; or `none`) |
| Staging | `TODO` (one span per app, `` `<app>: <url>` ``, and how access is protected; or `none`) |
| Staging bypass token location | `TODO` (a file only you read, e.g. `~/.config/desk/repos/<slug>/vercel-staging-bypass`: the path, never the token) |
| Production | `TODO` (URL and how it is deployed; skills never deploy it) |
| Vercel | `TODO` (team slug, then one span per project, `` `<app>: <project id>` ``; or `none`) |
| Slack channels | `TODO` (channels relevant to this repo, or `none`) |
| Check-out destination | `TODO` (where `/desk-checkout` drafts go: a Slack channel, a file path, or `none`) |

### People, by role

If you are one of these people, setup writes `you`. A solo repo is `you` in most rows.

| Role | Currently | Confirmed |
|---|---|---|
| Code reviewer | `TODO` (name and GitHub handle, or `none`) | `TODO` |
| Infra and security owner | `TODO` (who is told about infra PRs and added to security PRs; the paths that count as infra) | `TODO` |
| Product owner | `TODO` (who decides product and scope) | `TODO` |
| Designer | `TODO` (or `none`) | `TODO` |
| QA filers | `TODO` (whose repro steps are observed, not alleged; or `none`) | `TODO` |
| Deletes tickets | `TODO` | `TODO` |
| No longer on the team | `none` | — |

### What review here consistently asks for

The house bar for this repo. Setup can mine it from recent review history; edit freely.

| Ask | Detail |
|---|---|
| `TODO` | `TODO` |

## 5. Conventions

House style for this repo. Setup proposes values from recent merged PRs and branches; confirm them.

| Field | Value |
|---|---|
| Branch names | `TODO` (e.g. `<type>/<TICKET>-short-slug`: `fix/` bug, `feat/` feature, `chore/` other) |
| PR title | `TODO` (e.g. conventional commits `type(scope): <TICKET> description`; whether CI checks it) |
| AI attribution | `TODO` (`forbidden`: no `Co-Authored-By: Claude`, "Generated with Claude Code" or robot emoji in commits, PR bodies, Jira and replies, enforced by the hook in this repo only; or `allowed`) |
| PR body | `TODO` (sections, e.g. intro · `### Changes` · `### Testing` · optional `### Before / after`) |
| PR lifecycle | `TODO` (e.g. draft → local review until clean → post the sweep → undraft → merge on green) |
| Batches | serial to the merge: each PR merges as soon as it is green; a ticket sharing files starts once its predecessor merges |
| Ticket format | `TODO` (sections a new ticket carries) |
| Ticket comment | root cause in one sentence, fix in one sentence, PR link; skip it if a comment already carries the link |
| Code comments | `TODO` (e.g. default none; at most one short line) |
| User-facing copy you write | `TODO` (e.g. copy supplied by design or product ships verbatim) |
| Messages to colleagues | plain, direct, no filler: the fact, then the ask. Always a draft |
| Decisions put to you | one `AskUserQuestion` carousel, recommended option first and labelled, trade-off on each option |
| Vercel env vars | `TODO` (how to set them in this repo, or `none`) |
| Repo instructions | `TODO` (files the agent must also follow, e.g. `CLAUDE.md`, `AGENTS.md`; they win over this file on anything they cover) |
