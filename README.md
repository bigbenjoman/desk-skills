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

1. **Restart Claude Code**, so it loads the skills, agents and hooks.
2. **`cd` into a repo and run `/desk-setup`.** It detects what it can, you confirm it, and it asks
   every permission for that repo, one question at a time. Allow 15–20 minutes the first time.
3. **Repeat step 2 in each repo.** From the second repo on, setup can start from an earlier repo's
   answers, and you confirm each one.
4. **Before the first autopilot batch in a repo**, run its preflight once (see
   [Checking a repo's setup](#checking-a-repos-setup)).

Then `/desk-ticket <TICKET>` for one ticket, `/desk-autopilot <TICKET> <TICKET> …` for a batch, or
`/desk-autopilot <EPIC>` for a large feature written as an epic.

## Skills

| Skill | What it does | Start it with |
|---|---|---|
| `desk-setup` | Detects this repo's Jira, checks, toolchain and conventions, asks what the skills may do here, then writes this repo's config | `/desk-setup` |
| `desk-ticket` | One ticket, from triage to merged PR | `/desk-ticket ABC-123` |
| `desk-autopilot` | A batch of tickets (or an epic's children), one detached worker each, merged as each goes green | `/desk-autopilot ABC-1 ABC-2`, `/desk-autopilot ABC-900` |
| `desk-clearance` | Your open PRs: review comments, CI, branches behind the default branch, merging | `/desk-clearance` |
| `desk-cleanup` | Stale worktrees and branches, ticket statuses that drifted from GitHub, leaked memory (scripted scans in `bin/`) | `/desk-cleanup` |
| `desk-checkout` | Drafts your end-of-day check-out from calendar, meeting notes, Jira, GitHub, Slack and Claude Code; never sends it | `/desk-checkout` |
| `desk-pr` | Opening or updating a PR, screenshots included | loads itself |
| `desk-jira` | Ticket comments, edits, transitions | loads itself |
| `desk-review` | Reviews a branch, a PR or the open queue at this repo's bar: read-only finders, codex refutation, ticket checked both ways, posted as a verdict where allowed | `/desk-review`, `/desk-review 460` |
| `desk-kiss` | Makes a change smaller: the "should this be smaller?" passes desk-review runs on every review (scope creep, one-consumer abstractions, narrating comments against the ticket), then a per-finding fix offer | `/desk-kiss`, `/desk-kiss 460` |
| `desk-review-response` | Replying to and working a reviewer's comments | loads itself |
| `desk-dev` | Running the app locally, optionally against a copy of staging data | loads itself |
| `desk-update` | Brings every skill and plugin on the machine up to date, brew-style (see [Updating](#updating)) | `/desk-update` |
| `desk-reboot` | Before a reboot: every session, the runner VM, heavy processes and unsaved worktrees; busy sessions save a handoff; never reboots | `/desk-reboot` |
| `desk-ci` | Places each CI job self-hosted or hosted by a written rule, citing the line that decided it, and lints workflows so no self-hosted job receives a secret; measures CI minutes, red rate and time to green within an API call budget, and holds an autopilot batch's red rate to that baseline; saves and restores branch protection, pins required checks to GitHub Actions and makes the default workflow token read-only, each change shown first and gated on §3 `ci-protection` | `/desk-ci classify`, `/desk-ci ci-lint`, `/desk-ci measure`, `/desk-ci protection` |

A "ticket" is whatever this repo names work by: a tracker key (`VPL-123`), another id you list in
setup (a planning id such as `P1-M14-FIX-1`, a bug id such as `BUG-119-5`), or, in a repo with no
tracker, a GitHub issue URL or a plain description.

"Loads itself" means there is no command to remember: say what you want ("open the PR", "move it to
review", "reply to the review") and Claude loads the skill. Every skill can also be started by name.
All of them read this repo's config first, and do only what its §3 permissions allow: anything not
`yes` is asked before each use.

## Using the skills

### The ticket workflow

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
own worktree and port (see [Using autopilot](#using-autopilot)). Give it several tickets, or one epic
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

### Reviews

**`/desk-review`** reviews a branch, a PR or the open queue before a human does. It reports P0, P1
and P2 only, against this repo's review bar (§4 Review bar, else the default in
[`skills/desk-review/references/review-bar.md`](skills/desk-review/references/review-bar.md)).
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

### Your open work

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
the draft. It saves a Slack draft at most (§3 `slack-draft`), never sends.

```
/desk-checkout                   today (before 10:00, yesterday)
/desk-checkout yesterday         also a weekday name ("friday") or a date (2026-09-23)
```

### This machine and this repo

**`/desk-setup`** configures desk for the repo you are in (see [Setting up a repo](#setting-up-a-repo)).

```
/desk-setup                          first run, or change anything
/desk-setup permissions              straight to the permission interview
/desk-setup plugins                  only which plugins this repo needs; changes nothing else
/desk-setup from bigbenjoman__voicepa    start from another repo's §1, §3 and §3b answers
/desk-setup list                     every configured repo; changes nothing
```

**`/desk-update`** brings everything on the machine up to date (see [Updating](#updating)).

```
/desk-update                 report everything, then upgrade only what you pick
/desk-update outdated        report only
/desk-update ux-designer     check and upgrade named skills
/desk-update --all           upgrade everything that is behind, still after showing the diff
```

**`/desk-reboot`** gets the machine ready to restart. It lists every open Claude session with its
state (busy, waiting, idle) and age, the desk-runner VM, dev servers and heavy processes, and every
worktree in each configured repo with uncommitted changes or unpushed commits. Once you confirm, it
asks each busy or waiting session to finish its step and save a handoff, and runs `desk-runner down`.
It writes its own handoff, then ends with `READY TO REBOOT` or what still blocks it. It never stops a
session, never commits anyone's changes, and never reboots. The read-only half runs on its own:

```
node ~/.claude/desk/bin/reboot-check.mjs     worktrees across configured repos, the runner, heavy processes
```

**`/desk-ci`** proposes which of a repo's GitHub Actions jobs can move to the self-hosted runner.
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
printed as a plan first and applies only by that plan's id, under §3 `ci-protection`:

```
node ~/.claude/desk/bin/desk-ci.mjs classify     placement per job, with file:line
node ~/.claude/desk/bin/desk-ci.mjs ci-lint      exit 1 on any finding
node ~/.claude/desk/bin/desk-ci.mjs measure      CI cost and red rate over 90 days, sampled to a call budget
node ~/.claude/desk/bin/desk-ci.mjs protection   snapshot --ticket <KEY|none> | restore <file> | pin | token  [--apply <plan id>]
```

**`supervisor.mjs`** runs autopilot passes from launchd, with no Claude session in the loop. Install
it once per repo, from inside the repo. Its agent runs a pass at login and every 3 minutes for a batch
the orchestrator handed over at Stage 4, and appends each report to `<state>/supervisor.log`. It keeps
the batch's merge driver running, sends one macOS notification for each new set of items that need
you, and stops once the batch is idle. It passes on only the approvals the batch recorded at Stage 3.

```
node ~/.claude/desk/bin/supervisor.mjs install [--interval <s>]   write and load the agent (default 180s)
node ~/.claude/desk/bin/supervisor.mjs status                     the agent, the batch, the log's tail
node ~/.claude/desk/bin/supervisor.mjs uninstall                  remove it; no further passes for the repo
```

**`skill-eval.mjs`** runs a task set once with a skill loaded and once without it, so prose that
only restates what the model now does by default can be found. Each task is a prompt with pass/fail
checks on the final reply (`contains`, `absent` or `matches` a regex). Both arms run `claude -p`
with no setting sources, so no installed skill reaches either, in an empty directory of their own;
only the skill arm gets the skill's `SKILL.md`. The report lists each task's checks for both arms
side by side and ends with one verdict: **keep** (the skill arm passed more), **trim** (the same
number, with the transcripts linked to read) or **drop** (fewer). A run that fails or times out is
marked failed and counted neither way. It refuses to start without `--max-budget-usd`, each run's
spend ceiling:

```
node ~/.claude/desk/bin/skill-eval.mjs --skill <name|dir> --tasks <tasks.json> --max-budget-usd <usd> \
  [--skills-dir skills] [--out <dir>] [--timeout 600] [--model <model>]
```

```json
{"tasks": [{"id": "names-the-ticket", "prompt": "…", "checks": [{"name": "title has the key", "matches": "DS-[0-9]+"}]}]}
```

**`desk-runner`** runs the Linux VM that CI jobs will run in, on a computer whose machine profile
says a runner is possible (`desk-env machine get runner-possible`). It needs Tart and Softnet
(`brew install openai/tools/tart openai/tools/softnet`), with Softnet setuid root, which `up` tells
you how to set once.

```
desk-runner up                 create the VM at the profile's sizes, start it, verify isolation
desk-runner verify-isolation   probe from the VM and a container in it; non-zero names each failure
desk-runner status             the VM's state, the last isolation result with its age, the agents
desk-runner down               stop the VM, remove its agents, check nothing is left running for it
desk-runner settings           show the Mac settings a runner needs; change them if you say yes
desk-runner gate               exit 0 only while a new runner slot may start
desk-runner keep               bring the VM back if it is down, then refill the slots (its launchd agent runs this)
desk-runner scale <owner/repo> [n]   keep n single-use runners online for a private repo; 0 removes them
desk-runner slots              reap finished runners and start the missing ones now
```

**Runner slots.** `scale` gives a private repo `n` runners (the machine profile's
`runner-slots-per-repo` when `n` is left out); a public repo gets none, since any fork's pull
request could run on it. Each slot is one GitHub Actions runner, labelled `self-hosted`, `linux`,
`arm64` and `desk-local-pr`, registered from a JIT config that GitHub makes single-use and scoped to
that runner. It is requested on the Mac with your `gh` login, and only it enters the VM, so your
token never does. In the VM each slot has its own Docker daemon and network, which the runner
shares, so a service container mapped to 5432 is on the job's `localhost:5432`, and a `container:`
job sees the workspace. Slots share no daemon, volume or network. Each slot has CPUs of its own and
a memory limit, 2 CPUs and 7 GB unless the machine profile sets `runner-slot-cpus` and
`runner-slot-memory-gb`: `nproc` and Node's `os.availableParallelism()` show the slot's CPUs in a step
and in a `container:` job, so test runners size themselves to them, and `/sys/fs/cgroup/memory.max`
shows its memory in a step (a container job's reads `max`, though the slot's limit holds it). A job that runs out of memory fails on its own without taking the VM or
another slot with it. The VM runs only as many slots as it fits, the smaller of its CPUs over the
slot's and its memory less 2 GB over the slot's; when the repos want more, the slots are shared
between them in turn, and `status` lists each slot's CPUs and says how many are held back and why. A slot takes one job; within a
minute `keep` removes it with its containers and volumes and starts another. `down` deregisters
every slot's runner first, and the next `up` starts them again. The slot image is Ubuntu 24.04 with
actions/runner 2.338.0, Node 22.23.3, the Docker 29.9.0 CLI, gh, jq, shellcheck, build tools and
python3; `setup-node`, `setup-python` and `setup-uv` fetch other versions as on a hosted runner.

**The runs-on switch.** A job reaches a slot only if its `runs-on` names `desk-local-pr`. This one
sends a job there while the repo variable `DESK_RUNS_ON` is `local`, and to GitHub-hosted otherwise,
and always sends Dependabot's runs to GitHub-hosted, as `/desk-ci ci-lint` requires:

```yaml
runs-on: ${{ github.actor == 'dependabot[bot]' && 'ubuntu-latest' || vars.DESK_RUNS_ON == 'local' && 'desk-local-pr' || 'ubuntu-latest' }}
```

`gh variable set DESK_RUNS_ON --body local -R <owner/repo>` moves every such job to the slots;
`gh variable delete DESK_RUNS_ON -R <owner/repo>` moves them back, from the next run on. Put it only
on jobs `/desk-ci classify` places self-hosted: `ci-lint` fails any job it can send to a slot that
receives a secret. Nothing yet moves a repo back when the Mac is off, so switch it back before the
Mac sleeps or goes away for long.

Once isolation passes, `up` installs two launchd agents in your login session. One runs
`desk-runner keep` at login and every minute: if the VM is down, or its last check failed or is
more than 25 hours old, it starts and verifies the VM, waiting 1, 2, 4… minutes (at most an hour)
after each failed attempt. The other runs `verify-isolation` every night at 03:30. `gate` stays
closed, so no new runner slot starts, unless the VM runs behind the block and its last check passed
within 25 hours. `down` removes both agents before it stops the VM. FileVault means the VM comes back
only after you log in following a restart. `up` also shows the Mac settings a runner needs (never
sleep, restart after power loss, no automatic macOS update installs) and, in a terminal, changes
them with `sudo` only if you say yes.

The VM has no Mac folders and no forwarded ports, and Softnet blocks every private, shared and
link-local IPv4 range, the Mac's own address on the VM network included, so the guest resolves names
through public resolvers. `verify-isolation` proves it each time, from the VM's root shell and from
a container: no port of the Mac's address on the VM network answers (the root shell sweeps all
65,535), nor DNS there or at the router; nothing answers at the Mac's other addresses (their low
ports, your listening ports, and a test service on loopback and one on every interface), the router,
169.254.169.254 or a VM tool's host alias; and registry.npmjs.org and 1.1.1.1 do. Softnet's defaults
alone leave the Mac's address on the VM network open. It takes about a minute and a half.

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
[`vendor/sources.json`](vendor/sources.json) (how that works: [Skills, one copy each](#skills-one-copy-each)).
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

## Skills, one copy each

Every skill on the machine, desk's or anyone else's, has **one real copy** in
`~/.agents/skills/<name>`; `~/.claude/skills/<name>` is a link to it. No skill is copied into a repo
or duplicated between the two folders, so there is one thing to update and nothing to drift.

Besides desk's own `desk-*` skills, `install.sh` installs the third-party skills listed in
[`vendor/sources.json`](vendor/sources.json). Each entry records where the skill came from and
which version is installed, as one of three source types:

| Type | Use for | Where the files live | "Outdated" means |
|---|---|---|---|
| `github` | a skill published in a GitHub repo | `vendor/<name>/`, byte-identical to `{repo, path}` at `pin.commit` | a newer commit touches that path |
| `drive` | a skill published as a zip in a public Google Drive folder (e.g. Yummy Design's ux/ui skills) | `vendor/<name>/`, unpacked from the zip whose `sha256` is pinned | the folder's file name or modified date changed |
| `checkout` | your own skills, and upstreams you want to track live | a git clone at `~/.agents/skills/<name>`; nothing in `vendor/`. A repo holding several skills (`subskills`, e.g. `clerk/skills`) is cloned once to `~/.agents/sources/<name>` and each listed sub-skill linked in | `origin/<branch>` has commits you have not pulled |

`vendor/<name>/` is never edited by hand: its `tree_sha256` in `sources.json` is checked by
`skills-upstream verify`. A local change belongs upstream, or in a repo-level override
(`<repo>/.claude/skills/<name>`, which Claude Code prefers).

Claude Code only sees a skill through `~/.claude/skills/<name>/SKILL.md`; an installed copy with no
link there is "Unknown skill". `skills-upstream links` checks every skill desk installs (`desk-*`,
`vendor/*` and each `checkout` and its `subskills`) and prints the fix for each gap, usually
`ln -sfn ~/.agents/skills/<name> ~/.claude/skills/<name>`. A link or folder there that lands on any
other copy is reported too (SHADOWED), since Claude Code would run that stale copy. A `checkout`'s
`~/.agents/skills/<name>` must be its clone, or resolve into it for a sub-skill (WRONG COPY otherwise). When `~/.claude/skills` is itself a link
to `~/.agents/skills` there are no per-skill links, and a gap means the skill is not installed.
`install.sh` runs it after linking and under `--check`, and `verify` includes it.

`skills-upstream` (installed to `~/.local/bin`, runs from this checkout) manages them:

```bash
skills-upstream list                  # every tracked skill, its source and pin
skills-upstream outdated              # compare each pin with its source; exit 10 if any is behind
skills-upstream upgrade <name>...     # pull the newest upstream into vendor/ (or git pull a checkout)
skills-upstream upgrade --all
skills-upstream verify                # vendor/ matches sources.json, installed copies match vendor/, and links
skills-upstream links                 # every installed skill is reachable as ~/.claude/skills/<name>
skills-upstream is-clone-of <dir> <owner/repo>   # exact origin test install.sh and links share
skills-upstream plugins               # installed plugins vs their marketplaces
skills-upstream rehash                # re-record tree hashes after adding an entry
```

`upgrade` only writes `vendor/` (review it with `git diff`, then commit and run `./install.sh`); a
`checkout` upgrade is a `git pull --ff-only` in the clone and leaves nothing to commit here. To
track a skill that has no entry yet, prove a specific upstream version is byte-identical to the
installed copy first; a skill whose source cannot be proven stays untracked and is reported as such.

## Skill index: listing skills by name only

Claude Code resends every installed skill's description on every turn and cuts descriptions to fit
its budget (about 30,000 characters on a machine with ~170 skills, desk's own among those cut). So
`install.sh` builds a two-level catalogue and, if you agree, lists skills by name only:

- `skills-upstream index` writes `~/.agents/skills/skill-index`: a short map of areas (desk
  workflow, security and privacy, UX and design, ...) and `areas/<area>.md` with each skill's full
  description. Claude reads the map, then one area file. Areas come from
  [`desk/skill-areas.json`](desk/skill-areas.json); a skill no glob matches is reported, so add it there.
- `skills-upstream index --name-only` (asked by `install.sh`) sets your own and claude.ai skills to
  `name-only`, lowers `skillListingBudgetFraction` to 0.003, and adds
  `~/.claude/rules/desk-skill-index.md` pointing at the index. Entries you set yourself are kept.
- Plugin skills cannot be set name-only, so `/desk-setup` step 4b switches off, **per repo**, the
  plugins that repo does not need (from its own files, confirmed by you).

Measured 2026-10-02: the listing went from 29,954 to 9,648 characters; 29 of 30 test prompts loaded
the expected skill, and Claude opened the index on the 3 ambiguous ones. To undo: delete the
`skillOverrides` entries listed in `~/.claude/desk/skill-index.name-only.json` and
`skillListingBudgetFraction` from `~/.claude/settings.json`, and the rule file.

## Install

```bash
./install.sh            # install or update
./install.sh --check    # report missing tools and unreachable skills, change nothing
./install.sh --yes      # accept the prompts (not large downloads)
```

What it does:

- **Writes without asking** (desk's own files; a copy you edited is backed up first):
  the skills (`~/.agents/skills/desk-*`, linked into `~/.claude/skills`), the subagents and
  `/userflow` (`~/.claude/agents`, `~/.claude/commands`; a same-named file you already had is backed
  up), the third-party skills, the scripts (`~/.claude/desk/bin`), `desk-env`, `desk-runner`,
  `desk-q`, `desk-jira` and `skills-upstream` (`~/.local/bin`), and the four hook scripts.
- **Asks first** before changing `~/.claude/settings.json` (registering the hooks, adding the
  always-on deny rules, listing skills by name only), installing plugins, replacing a `desk-jira` it
  didn't install, registering the Playwright MCP at user level, or disabling the `playwright` plugin.

The four hooks: **`deny-ai-attribution.py`** (before each Bash command) refuses Claude trailers in a
repo whose §5 AI attribution is `forbidden`, **`desk-update-check.sh`** (at session start, at
most once a day) says when this checkout has new commits for `/desk-update` to install, and
**`desk-handoff.py`** (on prompt submit, after each tool, at turn end and at session start) has a
session in a configured repo write `.handoffs/<date>.md` once its context passes §2 Handoff at
context % (default 45; on a 1M window §2 Handoff at context % on a 1M window, which unset is the same), and points the session after `/clear` or a compaction at it.
**`desk-worker-stop.py`** is never registered in `settings.json`: each autopilot worker's own
settings run it at turn end. It blocks the worker's first attempt to end its turn while a background
task it started is still running, which `claude -p` would kill, and logs a second attempt.
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
| 4b. Plugins | Works out from the repo's own files which installed plugins it does not need, and switches those off for this repo only. | Confirm the list |
| 5. Write | Writes the config and prints every row back. | Check the summary |

Re-running `/desk-setup` in a configured repo changes only what you ask to change. Its other forms
are listed under [This machine and this repo](#this-machine-and-this-repo).

### Jira login, per repo

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

What each section holds (template and full rules: [`desk-config.md`](desk-config.md)):

| Section | Holds |
|---|---|
| §0 This repo | GitHub repo, default branch, a one-line description |
| §1 Who you are | name, GitHub handle, Jira email and account, git author, all per repo |
| §2 Paths | main checkout, worktrees, handoff and backup folders |
| §3 Permissions | the allowlist: every capability `yes`, `ask` or `no`, answered by you |
| §3b Cost and autonomy | budgets, concurrency, memory gates, dev-server port |
| §4 Tracker, tools and team | Jira (or `none`), work id patterns, required and advisory checks, merge holds, merge method, local review command, review bar, review domain experts, clean review verdict, toolchain commands, databases, staging, Vercel, Slack, check-out destination, people by role |
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
| A merge hold is `<glob>: <why>`, or `<glob>#<key>: <why>` to hold a JSON file only when that key changes; a PR touching it is always left for you to merge | `` | Merge holds | `backend/**: build and push the Lambda images first` | `` |

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

It also checks every shell script's and `.mjs` file's syntax, and runs `shellcheck -S warning` on
every shell script when shellcheck is installed (it says when it is not). On macOS,
`/bin/bash tests/run.sh` tests bash 3.2. CI runs it on Linux and macOS for every pull request.
`run.sh` finds every `tests/test_*.sh` and `tests/test_*.mjs` itself, so a new suite needs no edit
there: give it a `# suite: <label>` line (`// suite: <label>` in `.mjs`) near the top.

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

**An epic** runs as its open children (`/desk-autopilot ABC-900`). Jira "is blocked by" links are
honoured: a blocked ticket waits until its blocker's PR merges. Tickets sized L or XL are parked to
be split. When the last child merges, the epic's own criteria are checked; the epic's status is
left to you. Bea writes epics in this shape ("Hello Bea, this is an epic"), with an adversarial
readiness review before you approve them.

Run `/desk-autopilot` again to check progress, answer a parked question or resume. Batch state is
kept per repo, so two repos can run batches at once. Workers keep going if you close the session.

Workers are sandboxed: they start **without your own Claude Code settings** (`--setting-sources
""`), so a broad allow rule of yours never reaches them. A worker can push only its own branch, and
cannot merge, undraft, run git config or aliases, use `gh api`, or write outside its worktree.

## Updating

```bash
cd ~/desk-skills && git switch main && git pull --ff-only && ./install.sh
```

Pull and install only on `main`: a feature branch's files would put unmerged work in every session.
`main` is protected, so changes to desk-skills go through a PR, never a push to `main`.

Restart Claude Code. Repo configs are kept; if the template gained rows, `/desk-setup` in that repo
asks only those.

You don't need to remember to check: once a day, the first session you start says when desk-skills
has new commits.

**`/desk-update`** does all of it brew-style, from any directory: pulls desk-skills (only when the
checkout is on `main`), runs `skills-upstream outdated`, `verify` and `plugins`, reports one table
(outdated, drifted, unlinked, unreachable, untracked), says what changed upstream for each, and
upgrades only what you pick, after showing the diff. Upgrades are committed on a new
`chore/vendor-<date>` branch cut from `origin/main`, never on the branch you have checked out, and
installed by the first `/desk-update` after that branch merges. It never pushes the branch without
asking; when you agree, it pushes `chore/vendor-<date>`, opens a PR into `main` and prints its URL.

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
`docs/`. `desk-review` and `desk-kiss` are studia-web's `/pullbot` and `/kiss` made repo-generic,
and the subagents began as studia-web's. Upstream changes are checked from time to time and brought
back where they are not company-specific; the last check was 3 October 2026.
[`docs/porting-contract.md`](docs/porting-contract.md) records each mapping.
