# Skills reference

> Part of the [desk-skills docs](README.md). Back to the [main README](../../README.md).

Every desk skill in detail: what it does, how to start it, and what it may do without asking. For the one-line summary of each, see the [skills table in the README](../../README.md#the-skills).

## The ticket workflow

**`/desk-ticket <TICKET>`** takes one ticket from triage to a merged PR. It reads the ticket, routes
the work to the cheapest path that can solve it, then runs the same tail every time: diff hygiene, a
self-review with §4 Local review command (at most three rounds), screenshots where a picture helps,
the PR, the ticket transition, and the merge if you allowed it. Anything with consequences (product
or design calls, a fix that grows beyond the ticket) stops and asks.

```
/desk-ticket ABC-123                      a tracker key
/desk-ticket P1-M14-FIX-1                 another work id from §4 Other work id patterns
/desk-ticket https://github.com/o/r/issues/42   or "#42", in a repo with no tracker
/desk-ticket "the export button is greyed out for admins"
/desk-ticket ABC-123 --tail               resume an interrupted run from Stage 4 (verify, self-review, PR…)
```

It also applies mid-ticket to a single step: "just push it", "give me the PR body".

**`/desk-autopilot`** runs a batch unattended, one detached headless worker per ticket, each in its
own worktree and port (see [Using autopilot](autopilot.md)). Give it several tickets, or one epic
key to run the epic's open children. Come back to it ("how's the batch going?", "pick the batch
back up") to check progress, answer a parked question or resume.

**`desk-pr`** (loads itself) owns the pull request: a diff-hygiene block before any prose, the body
in the sections §5 PR body names (plus *Not migrated* when equivalent code was left on the old
pattern), before/after screenshots uploaded through a signed-in browser where §3 `pr-images`
allows, and stacked PRs. Ask for "the PR body" to get only the markdown.

**`desk-jira`** (loads itself) is every tracker write: create, edit, comment, assign, link, transition,
and a sweep that reconciles your in-review tickets against GitHub ("which of my tickets have
merged?"). It uses the per-repo `desk-jira` CLI, never the Atlassian MCP, and each write is gated
by its own §3 row (`jira-comment`, `jira-transition`, `jira-close`…). The CLI works on its own too:

```bash
desk-jira get ABC-123                          # the ticket, custom fields included
desk-jira search 'assignee = currentUser()'    # any JQL
desk-jira transitions ABC-123                  # where it can move next
```

**`desk-dev`** (loads itself) runs the app locally, and against a copy of staging data when the work
depends on real records (§3 `db-clone-staging`). It will not say "it's up with staging data" without
a filled-in proof block from live output, and it never writes to real staging without §3
`staging-write`, a backup and an independent review.

## Reviews

**`/desk-review`** reviews a branch, a PR or the open queue before a human does. It reports P0, P1
and P2 only, against this repo's review bar (§4 Review bar, else the default in
[`skills/desk-review/references/review-bar.md`](../../skills/desk-review/references/review-bar.md)).
Read-only finder subagents are routed by path (Lena always; Nadia, Theo, Mira, Jim, Suki or a §4
Review domain experts skill when their paths change, and desk-kiss's simplicity passes on every diff),
codex refutes each finding from a different vendor, and Bea checks the diff against its ticket in both directions. Where §3 allows, it posts one
`COMMENTED` review with a machine-readable verdict a required check can read. It never approves or
blocks.

```
/desk-review                     the current branch against its PR base
/desk-review 460                 one PR (number, #460 or URL); someone else's needs §3 read-others
/desk-review main...feat/x       a ref range, report only
/desk-review path/to/file.ts     one file in full, report only
/desk-review --sweep             every open PR not yet reviewed at its head (--limit N, default 30)
/desk-review --no-comment        report only, nothing reaches GitHub
```

`/desk-setup` offers to commit the CI side of it, `desk/templates/.github/workflows/desk-gate.yml`:
a `desk-review verdict` check that fails a PR whose latest verdict is missing, not at the head, not
clean, or under a heading that says otherwise; a `CLAUDE.md size` check (20,000 characters, the most
the reviewer loads); and an optional `protected-path approval` check that wants an approval on the
paths you list unless the PR is a small `fix`, `docs` or `chore` change. Each blocks only once a repo
requires it.

It is also what desk-ticket and autopilot workers run as their self-review. Codex is optional: when
it is missing, desk-review asks before falling back to Claude checking Claude, and says so.

**`/desk-kiss`** answers one question, should this change be smaller?, and offers to make it so. It holds the diff
against its stated intent (the ticket, else the PR body, else the commits, and names which) and looks
for scope creep, abstractions with exactly one consumer, and comments that narrate history or
restate the code. A justification gate and a refutation that argues the author's case run before
anything is reported. When the target is your checked-out `HEAD` on a clean tree, it then offers
each mechanical fix one at a time, showing the exact diff, and never commits. desk-review runs the
same passes on every review and reports what they find; reach for desk-kiss when you want those
simplifications made.

```
/desk-kiss        /desk-kiss 460        /desk-kiss main...feat/x
```

**`desk-review-response`** (loads itself) works a reviewer's comments: assess every comment first
and agree what to change, fix only that, self-review the fixes, then reply in two or three sentences
in this repo's review register and resolve the threads (§3 `pr-reply`). It also answers "is this
reviewer right?".

## Your open work

**`/desk-clearance`** takes your reviewed PRs the rest of the way in: works the comments (through
desk-review-response, one subagent per PR), resolves threads, updates branches, watches CI, merges
by the repo's method where §3 allows, and transitions the tickets. It only ever touches your own PRs.
One run is one pass; for repeats use `/loop desk-clearance` (while the session is open) or the
`schedule` skill (survives closing the terminal).

**`/desk-cleanup`** tidies up after a batch: it reconciles ticket statuses that drifted from GitHub,
removes worktrees whose PRs merged (§3 `worktree-remove`), reports local branches and PRs behind the
default branch, and finds leaked dev servers eating memory. It acts only on tickets assigned to you
**and** PRs you authored, and needs two independent signals before removing anything.

**`/desk-checkout`** drafts your end-of-day update from what actually happened: calendar meetings and
their Gemini notes, Jira changes, GitHub PRs, your Claude Code sessions and your own Slack messages.
It covers every desk repo that posts to the same §4 Check-out destination, and each source needs its
own §3 row (`read-calendar`, `read-transcripts`, `read-slack-public`…); a skipped source is listed in
the draft. To a Slack channel at §3 `slack-draft` `yes` it saves the post as a draft there and says
so, copying it to the clipboard only when the draft cannot be saved; it never sends.

```
/desk-checkout                   today (before 10:00, yesterday)
/desk-checkout yesterday         also a weekday name ("friday") or a date (2026-09-23)
```

## This machine and this repo

**`/desk-setup`** configures desk for the repo you are in (see [Setting up a repo](configuration.md#setting-up-a-repo)).

```
/desk-setup                          first run, or change anything
/desk-setup permissions              straight to the permission interview
/desk-setup plugins                  only which plugins this repo needs; changes nothing else
/desk-setup costs                    where each repo is billed (GitHub, Vercel, AWS), for the whole machine
/desk-setup from bigbenjoman__voicepa    start from another repo's §1, §3 and §3b answers
/desk-setup list                     every configured repo; changes nothing
```

**`/desk-update`** brings everything on the machine up to date (see [Updating](install.md#updating)).

```
/desk-update                 report everything, then upgrade only what you pick
/desk-update outdated        report only
/desk-update ux-designer     check and upgrade named skills
/desk-update --all           upgrade everything that is behind, still after showing the diff
```

**`/desk-reboot`** gets the machine ready to restart. It lists every open Claude session with its
state (busy, waiting, idle) and age, dev servers and heavy processes, and every worktree in each
configured repo with uncommitted changes or unpushed commits. Once you confirm, it asks each busy or
waiting session to finish its step and save a handoff. It writes its own handoff, then ends with `READY TO REBOOT` or what still blocks it. It never stops a
session, never commits anyone's changes, and never reboots. The read-only half runs on its own:

```
node ~/.claude/desk/bin/reboot-check.mjs     worktrees across configured repos, heavy processes, FileVault
```

**`/desk-ci`** proposes which of a repo's GitHub Actions jobs can move to a self-hosted runner. CI
runs on GitHub-hosted runners or a repo's own cloud runners; desk runs no CI on this computer.
`classify` places a job hosted when it uses a secret other than `GITHUB_TOKEN` (workflow-level env
included), an environment, `id-token`, a staging or preview URL, a third-party service, an image with
no arm64 build, or exists for production x64 build parity, and self-hosted otherwise, citing the
line that decided it. `ci-lint` fails a job that can run self-hosted and would receive a secret, an
environment or `id-token`, or whose `runs-on` has no `github.actor == 'dependabot[bot]'` branch to a
hosted runner. Neither writes anything. `measure` reports what a repo's CI costs and how often it
holds PRs up (billed and self-hosted minutes, failure and red rates, round trips, time to green,
queue time, minutes per merged PR), within an API call budget that leaves the rate limit a reserve,
and saves the report to the main checkout's `.handoffs/`. `protection` saves a repo's branch
protection and rulesets before any CI change and restores them, binds each required check to the
GitHub Actions app so a same-named status from a personal token no longer satisfies it, and makes
the default workflow token read-only once every workflow declares its permissions. Each write is
printed as a plan first and applies only by that plan's id, under §3 `ci-protection`.
`aws-fallback` is the other half of the AWS fallback watchdog (`.github/workflows/aws-fallback-watch.yml`,
every 10 minutes): when a repo listed in this repo's `DESK_AWS_WATCHED_REPOS` variable has had a job
queued on one of its declared AWS runner labels for over 15 minutes, the watchdog sets that repo's
`DESK_AWS_FALLBACK` variable to `on`, opens an issue here saying so, and cancels its queued runs and
re-runs their cancelled jobs. It never turns the fallback off; `aws-fallback off` does, and `aws-fallback status`
says whether each repo's fallback is on, since when, and when the watchdog last ran:

```
node ~/.claude/desk/bin/desk-ci.mjs classify     placement per job, with file:line
node ~/.claude/desk/bin/desk-ci.mjs ci-lint      exit 1 on any finding
node ~/.claude/desk/bin/desk-ci.mjs measure      CI cost and red rate over 90 days, sampled to a call budget
node ~/.claude/desk/bin/desk-ci.mjs protection   snapshot --ticket <KEY|none> | restore <file> | pin | token  [--apply <plan id>]
node ~/.claude/desk/bin/desk-ci.mjs aws-fallback status [--repo owner/name] | off --repo owner/name
```

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

The reviewers among them (Lena, Nadia, Theo, Mira, Jim, Suki, Bea) are also desk-review's finders.
There they report on the review bar's P0–P3 scale, which Lena, Nadia and Suki use natively.

## Third-party skills and plugins

`install.sh` also installs 59 skills other people publish, pinned in
[`vendor/sources.json`](../../vendor/sources.json) (how that works: [Skills, one copy each](install.md#skills-one-copy-each)).
They load themselves when a request matches; `skills-upstream list` prints them with their sources.

| Area | Skills |
|---|---|
| UX, UI and design | `ux-designer`, `ui-designer`, `ux-copywriter`, `ux-motion` (Yummy Labs), `frontend-design`, `web-design-guidelines` (UI review against the Web Interface Guidelines), `tailwind-design-system`, `kpi-dashboard-design` |
| Frontend (React / Next.js) | `nextjs-app-router-patterns`, `react-state-management`, `vercel-react-best-practices`, `vercel-composition-patterns` |
| Backend, APIs and data | `api-design-principles`, `openapi-spec-generation`, `error-handling-patterns`, `fastapi-pro`, `fastapi-templates`, `async-python-patterns`, `python-configuration`, `python-observability`, `python-performance-optimization`, `python-resilience`, `postgresql-table-design`, `supabase-postgres-best-practices`, `sql-optimization-patterns`, `database-migration`, `neon`, `neon-postgres`, `data-engineer`, `data-quality-frameworks`, `dbt-transformation-patterns`, `ml-pipeline-workflow` |
| Auth and payments | `clerk` (a live checkout of `clerk/skills` with its sub-skills), `stripe-integration` |
| Security and privacy | `api-security-best-practices`, `auth-implementation-patterns`, `secrets-management`, `gdpr-data-handling` |
| Infrastructure and deployment | `deployment-pipeline-design`, `github-actions-templates`, `docker-expert`, `gcp-cloud-run`, `monorepo-management` |
| Testing | `e2e-testing-patterns` (Playwright and Cypress) |
| Marketing and SEO | `seo-audit`, `ai-seo` (citation by AI answer engines), `schema` (JSON-LD), `site-architecture`, `programmatic-seo`, `competitors` (vs and alternative pages), `content-strategy`, `directory-submissions`, `product-marketing` |
| Domain | `backtesting-frameworks`, `risk-metrics-calculation` |
| Planning | `working-backwards` (Amazon-style PR/FAQ) |
| Claude Code tooling | `context-audit` (token waste in your setup), `context7-mcp` (current library docs), `find-skills` (discover and install more skills) |

And these plugins, each asked before installing: `superpowers` (brainstorming, plans, TDD,
debugging and other process skills), `code-review`, `code-simplifier`, `frontend-design`, `vercel` and
`codex` (the OpenAI CLI bridge desk-review refutes with). `/desk-setup plugins` switches off, per repo,
the ones that repo does not need.

PR image upload, GitHub sign-in and Claude's browser (the Playwright MCP desk-pr and desk-dev drive)
run on desk's own pinned Playwright, which `install.sh` puts in `~/.claude/desk/playwright` with its
Chromium and `@playwright/mcp`, so they work in every repo; a repo's own Playwright is left to its
tests. `install.sh` registers the MCP at user level, with `--isolated --storage-state` on the one
GitHub login `node ~/.claude/desk/bin/github-signin.mjs` saves, and offers to disable the
`playwright` plugin, whose own server would run beside it signed out. Sign in once per machine, and
again when GitHub expires the session (about every two weeks); every session in every repo and
worktree, and every upload, uses that login.
