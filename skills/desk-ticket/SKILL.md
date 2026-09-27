---
name: desk-ticket
description: >-
  Use when working on a Studia Jira ticket (SV-nnn) in the studia-web monorepo (the portal
  lives at apps/portal/) or a legacy studia-portal checkout, at any
  point in it: starting one ("do ticket SV-508"), or mid-ticket when about to commit, push,
  open or update a PR, comment on or transition the ticket, reply to a review comment, take
  screenshots, or clean up a branch or worktree. Also when resuming an interrupted session.
  Applies even when the request is only the single step ("just push it", "give me the PR
  body") rather than the whole ticket.
argument-hint: "SV-XXX [--tail]"
---

# desk-ticket

## Overview

One ticket, one entry point. This routes the work to the cheapest path that can actually solve
it, then runs the same tail every time so nothing gets forgotten.

**Core principle: the human decides anything that has consequences. Everything else is yours.**

**Read `~/.claude/desk-config.md` first** — §1 for the GitHub handle, §2 for the repo roots,
worktrees and handoff directories, §5 for branch and title conventions, and §3 for what you may do
without asking. Anything in §3 that is not `yes` needs asking before each use — assigning
(`jira-assign-self`), transitioning (`jira-transition`), pushing (`git-push`), opening a PR
(`pr-open`), posting a review (`pr-self-review-comment`), undrafting and arming auto-merge
(`pr-ready`, `pr-auto-merge`). A `TODO` is a question,
not a default.

Then read `references/desk-ticket-working-style.md` before writing code — it carries the
standing conventions on minimal changes, comments, branch naming, diff hygiene, generated files
and evidence capture.

## Stages

| # | Stage | What happens |
|---|---|---|
| 0 | Triage | Read the ticket fully — description, comments, linked issues, Figma. Note the issue type. Rename the session (below). Assign to the user if unassigned. Pick a **provisional** lane and state it with its cost, **plus which skills own which stage** (below). Write the resume file. **Do not transition the ticket yet.** |
| 1 | Branch | Off up-to-date `main`, prefix from the issue type. Worktree if another session is live, or lane C/D. **A new worktree then runs `node scripts/agents-sync.mjs`** — see below. |
| 2 | Understand | Read the code paths, and **what the knowledge base says about them** before writing any code (below). Reproduce the bug. **Commit the lane now** — this is the first point it is knowable. Transition to In Development. Flag anything wrong in the ticket. |
| 3 | Implement | Per lane. A change that is not mechanical gets its design from the area's expert first, and you write the code (below). Lane C stops for agreement before this stage; lane D hands the build to `muriel-design-engineer` (routing reference). |
| 4 | Verify | `desk-dev` for the environment. `bun run typecheck`, `bun run --filter studia-web lint:fix`, the `specs/` Jest suite and `bun run knowledge:check`; a build only when the change needs one (below). Add a spec that guards the fix. A changed claim from `knowledge:check` gets `/knowledge sync` in this branch (below). Then run the docs check from `desk-pr` §1 and **report** what it finds — a hit is sometimes a stale comment in the source rather than a page edit, and that is far cheaper to learn here than at Stage 7. Report only; rewriting a page is the user's call. |
| 4b | Self-review | Run `/pullbot` on the branch — **before** Stage 5, so a finding cannot invalidate screenshots already taken. Two preconditions, each a silent false clean otherwise: the tree must contain `.claude/skills/pullbot` (rebase onto `main` rather than skipping), and an empty diff is a stated skip, never a clean run. **Fix what the review confirms, then report** — do not stop and ask first. Apply every confirmed P0 and P1, and any P2 whose fix is mechanical, as their own commit. Produce the `SELF-REVIEW` block as a record of what was done, with an outcome against every finding. Re-run after fixes, **at most three rounds** — each fix is itself unreviewed code, so only a round that finds nothing has reviewed everything. If the third round still finds something, stop: report what is left, do not open the PR, and let the user decide. **Three things also stop and wait**, because no refutation settles them: a finding whose fix changes product, design or catalog behaviour; **a fix that grows** — it needs a new file other than its own spec, or a file the ticket's diff does not already touch (Moving equivalent sites onto a helper this PR creates or fixes is not growth. Migrate them all, or list each one under *Not migrated* in the PR body. Growth means new behaviour, not new call sites.); and any finding you could not confirm because the refutation pass did not run. |
| 5 | Evidence | **Only if the change alters what renders, or what a server route, webhook or job does at runtime.** For a rendered change, confirm the running server's HEAD matches your branch, capture before/after to `<handoff dir>/SV-XXX/` (config §2), and delete the Playwright artefacts. For a server or webhook fix, the evidence is the request or log that shows the fix running, not only a screenshot. If neither applies, skip the stage and say so in one line. |
| 6 | Hygiene | Diff review against the checklist in the working-style reference. |
| 7 | PR | **Invoke the `desk-pr` skill and follow it. Do not write the body from memory.** It owns the hygiene block, the permitted sections, the Testing-bullet standard and the before/after image table. Ends with `gh pr create --draft --body-file`, then the image upload. **Then post the Stage 4b report to the new PR**, then — where config §3 permits — **undraft it, arm auto-merge and shepherd it until it merges**. See "Merging" below. |
| 8 | Jira | Invoke `desk-jira`. Comment: root cause in one sentence, fix in one sentence, PR link. Nothing else — see "Jira comments" in the working-style reference. Transition by reading the available transitions, never a hardcoded name. |
| 9 | Cleanup | `git status` clean, release the lock, report the PR link and whether it merged. |

**Skill routing goes in the plan, not a closing checklist (Stage 0).** State a short table of which
skill owns which stage — `desk-ticket` for this ticket, `desk-pr` at Stage 7, `desk-jira` for
Jira writes, `desk-review-response` for any reviewer comment, `desk-dev` for the environment,
`desk-autopilot` for a batch of tickets — and name any the user would expect that you are **not**
using, with the reason. A plan that buries the routing reads as improvised process.

**Read the knowledge base before writing code (Stage 2).** The repo's CLAUDE.md requires it, and
Stage 4b's finders read the same files, so a documented rule learnt there costs a round. For each
file in scope:

```bash
bun run knowledge:check where <path>
```

Read the claims it names, not the whole domain file: they run to 84KB. If nothing resolves,
`.agents/knowledge/INDEX.md` routes by domain; if nothing documents the path, say so in one line.

**Experts shape the design; you write the code (Stage 3).** The project subagents are for
development as well as review. When a change is not mechanical, ask the agent that owns its area for
the approach before writing it, routed by path with the Role table in
`.agents/skills/pullbot/SKILL.md`: `suki-frontend-architect` for `.tsx`, components and i18n,
`theo-api-designer` for routers, repositories, schemas and Prisma, `nadia-security-auditor` for auth
and tenant boundaries, `mira-playwright-expert` for where a test belongs, `jim-solution-architect`
for infra. Brief it with the ticket, the repro and what you have read, and ask for the design, not
the code. Then write it in this session, which holds the ticket context and can ask the user;
splitting one change across agents by file type loses both. Mechanical changes need no consult. Lane
D is the exception (routing reference).

**Build only when the change needs it (Stage 4).** CI builds every PR. Build locally when the change
touches what typecheck, lint and Jest cannot see: `next.config.*`, dependencies, `middleware` or
`proxy`, route segment config (`dynamic`, `generateStaticParams`, metadata exports), or a
`"use client"` / `"use server"` boundary. `next build` runs its own type-check, so take the `tsc` lock:

```bash
~/.claude/desk/bin/with-lock.sh tsc bun run --filter studia-web build
```

**Keep the knowledge base true (Stage 4).** `bun run knowledge:check` also runs on every PR in CI.
It fails on a broken anchor (a cited symbol renamed or deleted) and only reports a claim whose code
changed. A reported claim is the trigger to write back: `/knowledge sync` it in this branch, so the
update ships in the same diff and Stage 4b reviews it. A domain whose shape changed needs
`/knowledge update <domain>`; propose that rather than doing it.

**Running the suites (Stage 4).** studia-web's `specs/` Jest suite is several hundred files and
thousands of tests in about **30 seconds**, and it sizes itself at `cpus - 1` workers with no
awareness of any other run. That is ~6.5GB resident on a 16-core box, so two at once oversubscribe
both RAM and CPU and each finishes slower than if you had simply waited.

**Cap it and lock it, every time** (the cap is config §3b's Jest row, `4`):

```bash
~/.claude/desk/bin/with-lock.sh test bun run --filter studia-web test -- --maxWorkers=4
```

`with-lock.sh` (installed by `install.sh`) serialises you against every other session and every
autopilot worker on the machine — they take the same lock, `/tmp/studia-test.lock` — and releases on
exit, including on a crash. It blocks rather than fails, and that wait is the feature. **Do not add a
timeout, and do not run two at `--maxWorkers=50%` instead.** It uses `flock` where it exists (macOS:
`brew install flock`) and otherwise a `mkdir` lock that takes over from a dead holder. Do not
hand-roll a lock of your own.

`tsc` is a single ~2.4GB process; take the same lock for it (`with-lock.sh tsc bun run typecheck`)
rather than running typecheck and a suite together. Screenshot and Playwright capture uses a separate
lock, `with-lock.sh browser …`, so it does not queue behind a suite it was never competing with. To see what is holding things:

```bash
pgrep -f '[j]est-worker'    # brackets required, or it matches your own shell
# room to start something — under ~4 GiB, wait
awk '/MemAvailable/{printf "%.1f GiB\n",$2/1048576}' /proc/meminfo                 # Linux / WSL
vm_stat | awk -v p="$(sysctl -n hw.pagesize)" '/free|inactive|speculative/{gsub(/\./,"",$NF);s+=$NF}END{printf "%.1f GiB\n",s*p/1073741824}'  # macOS
```

If config §2 "Running on WSL?" is `yes`, the practical ceiling is lower than the guest reports:
the Windows host runs out of RAM for VmmemWSL around config §3b "Memory ceiling for parallel work" (16GB) whatever `free` says, which is why the cap
is `--maxWorkers=4` rather than a percentage.

**Repo facts live in studia-web's knowledge base.** An `L-NNNN` below is a learning in
`.agents/knowledge/domains/`, where CI keeps it checked against the code; grep for the id for the
detail. The rule stays here because the knowledge base is not loaded until something points at it.

**Integration suites (`specs-it/`): never two at once** against the same Postgres — they tear down
each other's worker schemas (L-0209). The test lock does not cover Vitest reliably, so check for
another worktree's run first (`ps -eo args | grep -E '[.]bin/vitest run'`) and follow config §3
`specs-it-shared`.

**Self-review (Stage 4b).** `/pullbot` is the repo's own skill — `.agents/skills/pullbot/` —
reviewing the branch against `review-bar`'s P0/P1/P2 in 1–3 subagents, with every changed file
routed through `bun run knowledge:check where`. It only resolves in a tree that contains that
directory, so a checkout branched before it landed has to be rebased first. If it still does not resolve
after the rebase, the skill list was read when the session started — restart rather than working
around it. `/pullbot` failing to resolve is never a reason to skip the stage.

Skills load from the **main checkout** at session start, so a main checkout behind `origin/main` can
serve a stale pullbot that never emits the verdict marker `🌿 Local Adversarial Code Review` gates
on. Check `git show origin/main:.agents/skills/pullbot/SKILL.md | grep -c pullbot:verdict` and take
the contract from `origin/main` if the loaded copy lacks it.

The refutation pass is meant to be cross-vendor via `codex`, as the reviewer (config §4) requires.
Whether it answers is config §4 "Codex answers a real call?"; sending it diffs at all is §3
`codex-review`. Check it rather than assuming it,
because a logged-out or out-of-usage CLI fails the same way an absent one does:

```bash
codex exec --sandbox read-only "Reply with exactly: CODEX_OK"
```

**Not `codex login status`** — it reports logged in on a seat that is out of usage, so it passes
while every refutation fails. Only making codex answer tells you anything.

Exit 0 means usable. Anything else — an error naming a usage reset date, a capacity error, or no
output at all — means stop and say so; `codex login` is interactive and the user's to run. If they
say run it anyway, Phase 4 falls back to `ada-devils-advocate` and the `(same-vendor)` tag has to
survive into the gate block and into the PR body. Dropping it claims cross-vendor verification that
did not happen.

**Finders must stay read-only.** They inherit Edit and Write, and one will sometimes implement a fix
mid-round, even in a file the PR did not touch, so the review attests a tree nobody pushed. Check
`git status --porcelain` after every round; a dirty tree is an aborted round —
save the stray diff, restore, re-run, and say in the review that a round was discarded.

**Three rounds, then stop.** Review, fix, re-review has no natural end: every fix is new code a
finder can find something in. After the third round, stop whatever it found, report what is left,
and let the user decide whether a fourth runs. The count belongs to one loop; a later loop, for
reviewer feedback or after merging `main`, starts again at one.

**Posting the self-review (Stage 7).** Local reviews are posted to the PR so the reviewer (config §4)
can merge faster. So — where config §3
`pr-self-review-comment` allows — the Stage 4b report goes onto the PR as one `COMMENTED` review,
immediately after `gh pr create --draft`:

```bash
GH_TOKEN=$(gh auth token -u <GitHub handle, config §1>) gh pr review <n> \
  --repo Sophos-Education/studia-web --comment --body-file <report>
```

Open the body with `<!-- pullbot:local -->` — that marker is what lets a later sweep tell a real
review from the empty `COMMENTED` artefact GitHub records every time you reply to an inline
comment. The **second line is the verdict marker** pullbot emits
(`<!-- pullbot:verdict v=1 sha=<full head> p0= p1= p2= deferred= gaps= vendor= rounds= -->`); the
CI gate reads it at the PR's current head. **A later "fixed in `<sha>`" reply carries
`<!-- pullbot:reply -->` instead, and no verdict**: it posts at the new head, so giving it the review
marker claims that head was reviewed when it was not. **Never `--approve` or `--request-changes`.**
A clean run posts too: absence of a review must mean *not reviewed*, not *reviewed and clean*.

Stage 4b still runs **before** the PR exists, so this is a post of the report you already have — one
review pass per ticket, not two. The SHA and any `(same-vendor)` tag carry into the posted body
unchanged. If the head moved between 4b and the push — you fixed a finding, or rebased — re-run at
the pushed head rather than posting a report about a different commit. Never re-point an existing
marker's `sha=` at a new head.

**Counts never change at the same commit without a new run.** Never post a second verdict at a
`sha=` that already has one with different counts, and never edit the counts of one already posted.
The gate reads the last verdict at head, so a re-post that relabels findings is indistinguishable
from editing the result until it passes — a re-post that zeroes `deferred` with no code change can
clear a known P0. If a count is
wrong, re-run the review at that head and post that run.

**Declining a confirmed finding sets `deferred>0` and the gate blocks the merge.** Cost the fix
before deferring — "beyond scope" is usually a guess made without opening the file. A fix that stays
inside the ticket's files goes in this PR: a split buys nothing but a second PR, review and
merge. **A fix that grows stops and asks**: one that needs a new file other than its own spec,
or a file the diff does not already touch, is the "while I'm in here" red flag arriving through a
finding. The user chooses between widening this PR and splitting the finding to its own ticket.
Moving equivalent sites onto a helper this PR creates or fixes is not growth. Migrate them all, or
list each one under *Not migrated* in the PR body. Growth means new behaviour, not new call sites.

**Merging (Stage 7).** A draft cannot merge, so a PR left drafted is a merge silently deferred. If
config §3 `pr-ready` and `pr-auto-merge` are both `yes` (auto-merge merges on green by itself, so it also
needs `pr-merge-green`), right after the Stage 4b post:

```bash
gh pr ready <n> && gh pr merge <n> --auto --squash
```

Then **shepherd it until it merges** rather than handing back at "armed" — the same rules the
autopilot's merge driver follows, for one PR. If either row is `ask`, ask; otherwise stop at the draft
and report the link. Once it merges, and it was the last open PR on the key, move the ticket to
`Done` via `desk-jira` under §3 `jira-close-own-merged`.

- **Merge on `🏁 CI gate` alone** — the ruleset's sole required check. Read it with `awk -F'\t'`;
  `gh pr checks` is tab-separated and the emoji breaks whitespace splitting.
- **The review gate fails on a fresh PR's first run when the review posts late.** CI runs only on
  open, reopen and push, so posting a review starts nothing. The gate job polls for the verdict for
  about a minute after the run starts, and a review posted inside that window passes the same run.
  If the post missed it, wait for the whole run to reach `completed`, confirm the verdict's `sha=`
  is the head, then rerun it.
- **Red gate: read why before acting.** Retrigger only a run that has reached `completed`, found by
  head SHA (`gh run rerun <id> --failed`). Rerunning one in flight cancels it, and a fast loop
  starves the PR forever.
- **Red `🚀 Preview build` is usually Vercel OOM** (exit 137), not the code —
  `vercel inspect --logs <url> --scope sophos-education-27386abb` first. One preview build at a time.
- **`DIRTY` merges nothing.** Merge `main`, typecheck, then re-run Stage 4b at the new head and post
  it: the gate matches the pullbot verdict against the exact head SHA.
- **Human review feedback lands while armed** and §3 `merge-feedback-first` is `yes`:
  `gh pr merge <n> --disable-auto`, work it via `desk-review-response`, then re-arm.
- **Never `--admin`.** Any code change while shepherding gets the same diff record and self-review.

**A new worktree has no agents until you sync it (Stage 1).** `.gitignore` ignores
`.claude/agents/*.md`, so a fresh worktree starts with that directory empty and every named agent
silently resolves to `general-purpose` — every Phase 3 finder, and the `ada-devils-advocate` that
Phase 4 falls back to when codex is unavailable. Nothing warns you. First commands in a new
worktree:

```bash
node scripts/agents-sync.mjs        # expect "created (N)"
~/.claude/desk/bin/copy-env.sh    # .env from the main checkout; bun install fails without it
```

If a review did run without them, say so in the report header rather than letting it pass as a full
fleet run.

For lane predicates, costs, demotion triggers and how lanes C and D run: **read
`references/desk-ticket-routing.md`**.

`--tail` skips to Stage 4 using the resume file. Use it to pick up an interrupted run.

## Keep them posted

Report at **every stage boundary** — one or two lines: what finished, what's next. Say what you're
about to do before any step that takes more than a minute or two, and surface findings as you hit
them rather than saving them for the end. People run several sessions at once; going quiet is the
problem. Full rule in `references/desk-ticket-working-style.md`.

**Decisions go in a question carousel.** When a ticket turns up choices the user must make, ask with
`AskUserQuestion` — one question per decision, your pick first labelled `(Recommended)`, a one-line
trade-off on each option — rather than a prose list of defaults.

## Session rename (Stage 0)

Sessions want naming for the ticket so parallel ones are tellable apart:

```
SV-<number>-<type>        SV-448-bug   SV-473-task   SV-440-story
```

`<type>` is the literal Jira issue type, lowercased — `bug`, `task`, `story`.

**You cannot do this yourself.** `/rename` is a built-in command and only the user can type it.
Writing the `name` field in `~/.claude/sessions/<pid>.json` does change the stored value, but the
running process owns that file and the displayed title does not pick the change up mid-session — so
it looks like nothing happened.

So at Stage 0, ask for it in one line and move on. Don't wait for it, and don't edit the file:

> Worth renaming this session: `/rename SV-612-bug`

If the ticket type isn't obvious yet, say the name once you know it rather than guessing.

## The eight gates

Each one stops and waits for the user unless config §3 grants it. Silence is not agreement.

1. **Never invent product data.** Catalog entries, subject names, levels, prices, business
   rules — if the real value isn't in the ticket, the sheet, or the database, ask. Prefer an
   authoritative source, or "only what's real", over a plausible list.
2. **Show Jira text.** Whether it blocks depends on config §3 `jira-comment`, `jira-create` and
   `jira-edit`: at `yes`, comments, new tickets and description edits post without
   blocking, provided the exact text is printed as it goes, so the user reads what *was* posted; at
   `ask`, print it and wait. Three are decisions rather than records, and wait: **closing a
   ticket** any way other than the `Done` after the user's own last PR merges (§3 `jira-close`; that
   `Done` is `jira-close-own-merged`), anything **routed to another person** (§3 `jira-route`), and
   anything asserting a **product or catalog fact** gate 1 covers, which waits whatever §3 says. Read every write back afterwards: `desk-jira edit` reports
   `updated SV-XXXX` even when it wrote nothing useful, and a select custom field passed as a bare
   string 400s where `customfield_10159='{"value":"P1"}'` succeeds.
3. **Show the diff before pushing.** At config §3 `git-push` `yes`, print the `DIFF REVIEW`
   block as a record and push; at `ask`, print it and wait. The stray-commit check below hard-stops
   either way.
4. **Leave the dev server running** on the port recorded in the resume file so the user can test
   it themselves. Never `pkill node`.
5. **A reviewer's comment gets validated before any code changes.** Say whether it's correct
   and why, first — via `desk-review-response`, loaded rather than approximated.
6. **Any shared-state mutation stops first** — reindexing local Typesense, a concurrent
   integration run another session may collide with, or any write to real staging.
7. **Self-review findings are acted on before the PR exists.** Stage 4b fixes what it
   confirms rather than asking permission per finding, and its block reports the outcome
   against every one — fixed (with the commit), declined (with the reason), or escalated
   under one of Stage 4b's stop conditions. The gate is that the block exists and
   accounts for every finding, not that the fixes waited.
8. **Legal and compliance content is findings-first.** A change to legal documents or policy
   copy goes to the ticket as a findings comment, with implementation split into a follow-up that
   waits for team sign-off — even when the fix is tested locally. A standing grant
   in config §3 does not cover it. When a legal change does ship, `LEGAL_LAST_UPDATED` moves in the
   same commit (L-0215).

### Gates 2, 3 and 7 are slots, not intentions

Produce these blocks. A stage that should have one and doesn't is incomplete:

```
JIRA <TICKET | COMMENT | EDIT | TRANSITION> — <posted | awaiting approval>
target : <SV-XXX, or "new ticket in SV">
fields : type · assignee · labels · priority · launch priority · size · impact · repository
---
<the exact body, verbatim>
```

Print it with `posted` at the moment it goes when §3 grants it. It is `awaiting approval` for the
three exceptions in gate 2, when §3 says `ask`, and for anything you are unsure sits inside the
grant — an unnecessary pause costs a message, whereas a wrongly-posted product claim or a ticket
landed on a colleague costs a retraction.

```
SELF-REVIEW
reviewed  : <branch> → <base> at <sha> · <n> files · <tier> tier · <k> finders
refuted   : <codex, or "ada-devils-advocate (same-vendor)" and why codex was unavailable,
             or "did not run" and what confirmed the findings instead>
domains   : <what knowledge:check named, or "none — nothing documents these paths">
P0 (n)      <file:line — one line each>
P1 (n)
P2 (n)
REQ GAPS (n)  <SV-XXX — the criterion>
caveats   : <any check the run could not perform, or "none">
outcome   : <per finding: fixed in <sha> · declined, and why · escalated, and which
             stop condition it hit>
rounds    : <n> of 3 in this loop
re-review : <result at the new head, or "not needed — nothing was changed">
```

**Every finding gets an outcome line, including the ones you fixed.** The block is a record rather
than a request, so it is the only place a reader can see that a P0 existed at all — a finding that
is silently fixed and never reported reads afterwards as a review that found nothing.

**"No P0, P1 or P2 across n files" is a result and still gets the block.** An absent block is
indistinguishable from never having run it, which is the one thing this gate exists to rule out.

**The `caveats` line is the one that earns the gate.** A clean report where a check silently did
not run is worth less than a report with a finding, and the difference is invisible unless it is
written down. Two that have happened: `knowledge:check` named **no** owning domain for
`src/lib/auth/vercel-oidc.ts`, so no domain file reached the finders and the
`KNOWN GAP` / `L-####` / `kind: rejected` false-positive filter never applied; and the finders read
the specs statically rather than executing them. Neither changes the verdict. Both change how much
the verdict is worth, so both go in the slot.

```
DIFF REVIEW — <recorded | awaiting approval>
files changed : <n>   (<list>)
commits ahead : <output of git log --oneline origin/main..HEAD>
artefacts     : <git status --porcelain, or "clean">
```

**Before any push, `git log --oneline origin/main..HEAD` must contain only your own commits for
this ticket.** If it contains anything else, do not push — report the stray SHAs and offer to
move your commits onto a clean branch off `origin/main`. This has happened: another session's
work went up attached to an unrelated ticket.

## Red flags — stop

- About to write a value you can't point to a source for
- "It's probably called X" / "the label is likely Y"
- Concluding "this helper does not exist" from a local grep rather than `origin/main`
- About to `git push` without having shown `origin/main..HEAD`
- Editing code in response to review feedback you haven't yet assessed
- "While I'm in here" — new behaviour this ticket does not require. Moving sibling sites onto a
  helper this PR creates or fixes is finishing the fix, not this
- Adding a test nobody asked for, or hardcoding the ticket's example into one
- A one-off script in the diff
- Committing a legal or policy edit rather than posting findings
- Escalating to lane C or D without naming the signal that justified it
- Writing code in a documented domain without having run `knowledge:check where` on its files
- Handing an expert subagent the implementation rather than asking it for the design
- About to open a PR without having run Stage 4b
- Starting a fourth review round without the user
- About to post a verdict at a commit that already has one, with different counts
- Treating `/pullbot` not resolving in this tree as a reason to skip it rather than to rebase
- Dispatching finders in a worktree without having run `agents-sync.mjs` — they are all
  `general-purpose` and the report will not say so
- Posting a review whose header does not state which agents actually ran, what refuted the
  findings, or that drops the SHA
- Claiming a codex refutation on a run where codex was never made to answer
- Treating a user's "should we…?" as an instruction — it opens a discussion; answer with a proposal

## Rationalizations

| Excuse | Reality |
|--------|---------|
| "The data is obviously missing, I'll fill it in" | Inventing GCSE subjects that didn't exist cost a full revert and a restart. Missing data is a question, not a gap to close. |
| "It's a one-line change, I'll just also tidy this" | The most frequent review complaint is unnecessary files in the diff. Unrelated tidying is that; migrating the sibling sites of a helper this PR creates or fixes is not, so migrate them or list each under *Not migrated*. |
| "They said push it, they're in a hurry" | Urgency is a reason to show the diff, not to skip it. A contaminated push costs far more than 20 seconds. |
| "The reviewer is senior, just make the change" | Two of a senior reviewer's comments turned out not to apply. Answering first is faster than changing twice. |
| "A spec would make this more robust" | Unasked-for tests have been removed from three PRs. Ask. |
| "The ticket seems big, I'll stop for a plan" | A ticket that looks big can be a one-line deletion. Name the signal or take lane A. |
| "I'll reindex quickly to check" | The Typesense collections are global. That is every other session's index. |
| "I'll tell them once it's all done" | They want to test it themselves before the PR exists. |
| "The design has placeholder copy, so the ticket is blocked" | Build with the placeholders in as real i18n keys and raise **one** spin-off ticket for all of them. |
| "Self-review found nothing, so there is no block to show" | The empty result is the finding. Show it. |
| "I should ask before fixing this finding" | Stage 4b fixes what it confirms. Only the stop conditions wait — product/design/catalog behaviour, a fix that grows, a finding the refutation pass never confirmed, or a third round still finding things. |
| "The P0 is fixed, so the block can just report clean" | Then nobody ever learns a P0 existed. Fixed findings still get an outcome line naming the commit. |
| "One-line change, self-review is overkill" | LOW tier is a single finder against a one-line diff. Cheapness is why it is a gate and not a ceremony. |
| "I'll defer this P2, it's out of scope" | `deferred>0` blocks the merge gate. Cost the fix first. Inside the ticket's files, fix it; needing a new file or one outside the diff, stop and ask. Moving equivalent sites onto a helper this PR creates or fixes is not growth. Migrate them all, or list each one under *Not migrated* in the PR body. Growth means new behaviour, not new call sites. |
| "One more round will get it clean" | Three is the cap. Stop and report what is left. |
| "The deferred count was wrong, I'll re-post it corrected" | Changed counts need a new run. A re-post can clear a known P0 with no code change. |

## Resume file

Written at Stage 0, appended at **every stage and gate boundary** — sessions are lost to network
drops regularly, and a file written once is useless for that.

**Path: `.claude/desk-ticket-SV-XXX.json`, in the working tree where the work is happening** —
inside the worktree when using one, otherwise the main checkout. Untracked.

**Exactly one file per ticket.** Before resuming, look for it across the main checkout *and* every
worktree (config §2 primary repo root, worktrees directory, and the legacy studia-portal checkout
unless it is `none`):

```bash
find <primary repo root> <worktrees dir> [<legacy studia-portal checkout>] -maxdepth 3 -name 'desk-ticket-SV-XXX.json'
```

If more than one turns up, **stop and ask which is authoritative** — do not guess, and do not merge
them. Two files for one ticket means two sessions were working it, and picking the wrong one
resumes the wrong state.

**A resume file whose ticket is already `Done` is stale — never resume from it.** Check the
ticket's status before trusting the file. If the ticket is closed, say the file is spent, offer to
delete it, and start fresh rather than replaying finished work.

The file is removed when the ticket reaches `Done`, not when the PR opens — `--tail` still needs it
while the ticket sits in `Review/QA`.

Records: ticket and type · provisional vs committed lane, with the Stage-2 evidence · worktree
path · branch · base `main` SHA · dev-server port · locks held · **the pending gate, the exact
payload already shown, and which answer is awaited** · Jira mutations already made (assignment,
transition, comment marker) · the Stage-4b review: the head SHA reviewed, its findings, the outcome
and fixing commit against each, and the re-review result · PR number and merge state · screenshot
directory state.

On invocation, if the file exists, resume from it — and re-verify external state before trusting
it: does the branch still exist, is the ticket still In Development, are there new comments, has
the PR merged?

Jira writes must be idempotent across a resume. Put a stable `SV-XXX/desk-ticket` marker in
comments and search for it before posting, or a resumed run double-posts.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Writing the PR body from memory instead of invoking `desk-pr` | The PR can ship with no before/after table and a section the convention forbids. The sibling skills own their stages — `desk-pr` for Stage 7, `desk-jira` for Stage 8, `desk-review-response` for review replies. Recalling the gist of one is not following it: working 72 review comments "in its spirit" dropped the assess-first table and the reply voice. |
| Committing the lane at Stage 0 | A symptom patch plus a spec that codifies the wrong behaviour |
| Transitioning the ticket before Stage 2 | A crash leaves a claimed ticket with no branch |
| Handing the implementation to an expert subagent | It has none of the ticket, repro or code reading this session built, and cannot ask the user. Ask it for the design; write the code here |
| Assuming port 3000 is yours | Another session may own it; screenshots may be of another branch's code |
| Capturing evidence before Stage 4b | A confirmed finding means a code change, and every screenshot is then of the old build |
| `git stash` to stage the "before" shot after committing | It no-ops with nothing to stash, and stashes are shared across worktrees, so the "before" can be the fixed code. Use `git checkout HEAD~1 -- <path>` |
| Leaving a PR in draft once review is clean | A draft cannot merge; the merge is silently deferred |
