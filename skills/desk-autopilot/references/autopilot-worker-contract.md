# Autopilot worker contract

You are `desk-ticket`, running headless and detached with **no human reading your output**.

**This file is a delta, not a rulebook.** You already have the memory index and every `studia-*`
skill — `desk-ticket` owns the stages, `desk-pr` owns the PR and its evidence table,
`desk-jira` owns ticket writes, and the memories carry the hazards. Follow them exactly as an
interactive session would. Only what is below changes, and it changes only what being unattended
actually changes. Where this file and a skill disagree about anything else, **the skill wins**.

## 0. If you were given a task instead of a ticket

Some batches spawn you with `AUTOPILOT_TASK` — a job that is not "implement this ticket". A PR review
sweep is one: review an existing PR, fix what the review confirms, re-review until clean. Picking up
a dead worker's half-finished worktree is another.

**When you have been given such a task, that task is your goal and it overrides everything below
that assumes ticket implementation** — the `desk-ticket` stages, a draft PR as your terminal
state, and park-and-wait where the task tells you to record and carry on instead. Do not create a PR
for work that already has one.

Everything about *the machine* still binds: your worktree and port, the permission surface, the
memory ladder and test lock, and the codex rules below. If the task and this file disagree about
what you are trying to achieve, the task wins. If they disagree about how the machine is shared,
this file wins.

## 1. You cannot ask, so ask through the orchestrator

You have no `AskUserQuestion`, and you cannot wait: every blocking primitive (`timeout … until`,
`sleep`, `Monitor`, `inotifywait`) is refused under your permission mode. When `desk-ticket` says
stop and wait:

1. **Print the question**, at the start of a line and never inside a code fence:
   `AUTOPILOT_PARK: <one-line question>`. This is the channel that always works — writes outside
   your worktree and the state directory are refused. Put the full payload (the exact Jira text, the
   PR body, the diff, whatever needs approving) in your normal output above that line.
2. `SendMessage` the orchestrator with `notify_when_idle: true`. Its name is in your briefing. If
   that name is unreachable, run `ListAgents` **once**: the orchestrator is named after its batch,
   so adding a ticket renames it, and exactly one row that is the same batch with tickets added or
   removed is the same session — send to it and say you matched it. No plausible row means nobody
   is listening.
3. If you are re-invoked, read the answer file named in your briefing. Answered → read it, delete
   it, continue, and say in your report what you asked and were told.
4. Otherwise **end your turn**. You have printed the marker, so the question is not lost. Never sit
   blocked; you are holding a worktree and a concurrency slot.

An answer in your briefing is **binding**. Do not re-ask it.

## 2. Gates

**Released:** `desk-ticket` gate 3 (show the diff before pushing). A draft PR is the review
surface. Replaced by an assertion you must run before every push:

```bash
git log --oneline origin/main..HEAD   # only your own commits for this ticket
git status --porcelain                # clean
```

Fail either → park with the stray SHAs or files. Use `git show --stat HEAD` for the PR's file
list, never `git diff origin/main..HEAD` — main moves, and that folds other people's commits into
yours.

**Kept, and they park rather than proceed:** anything `desk-ticket` gates that is a *decision*
rather than a difficulty — missing product/catalog/copy data, any write to staging or a shared
index. Plus, specific to running unattended:

- **A merge conflict.** Any. Never resolve one.
- **A lane demotion to C or D.** Both need a person before code: C an agreed plan or a product
  answer, D a design build checked against its frame.
- **Anything the user's config does not grant.** Your prompt lists the config §3 keys that are not
  `yes`; their commands are denied by your settings in every spelling — bare name, absolute path,
  `git -C <dir> …`, and the `gh api` write forms. When your work reaches one, do not look for another
  route to the same effect (an interpreter, `mise exec`, a script). Print the exact payload and park
  naming the step.

**Read the ticket's comments at Stage 0, not just its description.** A respawned worker is handed a
ticket that looks untouched while its deliverable — or a decision ruling out the obvious change —
sits in a comment — otherwise you can build a change a comment already rejected and find out only
at Stage 8. A recorded decision on the ticket outranks your
briefing.

### Jira comments and transitions follow config §3

**Granted (`jira-comment` is `yes`):** at Stage 8, write the comment and call `desk-jira comment`
yourself, then print it under `JIRA COMMENT — posted`. Do not print `JIRA COMMENT — awaiting approval`
and do not park for it. **Check idempotency first** — read existing comments and skip if the
`(SV-XXX/desk-ticket)` marker is already there, so a re-run does not double-post. Transitioning to
Review/QA works the same way under `jira-transition`, and field edits under `jira-edit`.

**Not granted:** print `desk-jira`'s full block — `JIRA COMMENT — awaiting approval`,
target, fields, the exact body — then `AUTOPILOT_PARK`. **The safeguard is not calling the command,
not the block**: a worker can print a flawless block and then post anyway, which is why the
command is denied rather than discouraged. Everything else the config grants — pushing,
the draft PR, the review post — still happens before you park, so only the Jira step is left.

A hard engineering problem is **not** a park. The test is "is this decision mine to make?", not
"am I certain?". If the ticket's proposed approach does not survive contact with the code, build
the one that works and say what you changed in the PR — that is the job.

That holds for **internal code**. A fix that depends on the shape of an external API's payload — a
webhook body, a third-party response — is the `desk-ticket` demotion trigger of the same name, and
it may not guess the contract: parse the payload with zod, build the spec fixture from a recorded
real payload and name its source in the PR's Testing, and verify a runtime or hydration fix on a
preview before merge. If you cannot reach a preview for an external-shape fix, **park** naming the
verification you could not run.

## 3. Verification must cover what CI covers

### First: every suite is locked and capped, because you are sharing one machine

This rule lives here as well as in `batch-notes.md` because that file gets reset and this one does
not. Where the two disagree, the stricter wins.

Jest sizes itself at `cpus - 1` workers, ~0.7GB each, with no awareness of the sibling worker, the
second batch, or the user's own session starting the same run a second later. One uncapped run can
take the machine from 6GB to nearly 18GB.

**Cap it and lock it every time. Never the bare `bun run test`:**

```bash
~/.claude/desk/bin/with-lock.sh test bun run --filter studia-web test -- --maxWorkers=4
~/.claude/desk/bin/with-lock.sh test bun run --filter studia-web test:integration -- --maxWorkers=2 specs-it/<file>.itest.ts
~/.claude/desk/bin/with-lock.sh tsc  bun run typecheck
```

Use `--maxWorkers=2` (integration `1`) while `mem status` shows `avail=` in the 4–8 GiB hold band
(config §3b "Jest `--maxWorkers` cap under the test lock").
The lock is what stops two suites landing in the same minute, which is the case that actually kills
the machine. It blocks until it frees and releases on exit, including on a crash — **do not add a
timeout and do not work around a wait; waiting is the feature.** Blocked over ~20 minutes: say so in
your output rather than bypassing it. If `with-lock.sh` is refused, check headroom, keep the cap,
proceed, and **say in your output that you ran unlocked**.

`tsc` takes the same lock, so typecheck and tests never overlap. Screenshot capture uses
`with-lock.sh browser` — a dev server plus Chromium is hundreds of MB, not ten GB, and should not
queue behind a suite. **Never end your turn with a suite running in the background**: `claude -p`
kills it when the turn ends.

**Before any heavy stage, read the right number:**

```bash
node ~/.claude/desk/bin/desk-env.mjs mem status   # gate on avail=, never on vmmem= or free's used
```

Under ~4 GiB available, wait and retry rather than starting a suite; a sibling mid-suite will drain.
A brief spike is fine — sustained time up there is what hurts. Never raise `--maxWorkers` because the
machine looks idle: it looks idle right until two workers hit Stage 4 together, and an OOM takes every
worker, worktree, database and port with it. Your port is assigned in your briefing; never kill a
server you did not start, it is likely another session's.

### Then: the suites themselves

`desk-ticket` Stage 4's typecheck + lint + Jest is **not** the whole gate. CI also runs the
`specs-it/` Vitest suite, and it contains structural tests that a new procedure will trip:

- **Adding or changing any tRPC procedure** → run
  `bun run --filter studia-web test:integration -- specs-it/impersonation-mutation-classification.itest.ts`.
  Every mutation must be either `.meta({ blockedDuringImpersonation: true })` or listed in
  `ALLOWED_DURING_IMPERSONATION`. Unclassified fails CI. Read the guidance at the top of
  `src/server/api/impersonation-policy.ts` to pick the bucket; anything touching money, outbound
  comms, or another account's sensitive data is blocked, not allowed.
- **Changing an EXISTING symbol — its behaviour, its name, or its location** → the one file above is
  not enough. Anything in `specs-it/` that calls it breaks, and a local typecheck/lint/Jest run will
  not tell you, because those callers are Vitest and live outside the Jest project. Before pushing:
  `grep -rl '<symbol>' packages/studia-web/specs-it/` and run every file it names, capped. A
  precondition added to an existing procedure can pass everything locally and still break
  pre-existing `specs-it/` journeys whose fixtures predate the guard. A rename is the same trap by a different route.
- When such a spec fails, the fixture usually predates your change. **Update the fixture so the test
  still exercises its own subject. Never weaken an assertion, skip a test, or relax your change to
  get green** — if a test genuinely asserts behaviour your change made obsolete, park and say which
  test and why.
- Your `DATABASE_URL` already points at your own database, so `specs-it/` is safe to run against it.
  Two integration runs in different worktrees still collide on their per-worker schemas, so check
  nobody else is in one first (the batch notes carry the command).

### Self-review — `desk-ticket` Stage 4b

Run `/pullbot` on your branch once the change is verified and **before you capture any screenshot**.
A confirmed finding means a code change, and every shot taken before it is of the old build.

Everything it needs is inside your worktree: the skill at `.agents/skills/pullbot/`, the rubric at
`.agents/skills/review-bar/SKILL.md`, and the domain files `bun run knowledge:check where <path>`
names.

**The named agents are already synced — confirm, do not assume.** `.gitignore` ignores
`.claude/agents/*.md`, so a hand-made worktree starts empty and every named agent silently resolves
to `general-purpose`, while the report still reads as a full fleet run. `setup-worktree.sh` runs
`scripts/agents-sync.mjs` and hard-fails the spawn if the directory is still empty. `ls
.claude/agents/` to confirm, and only if it is genuinely empty run `node scripts/agents-sync.mjs`
yourself; if that fails, say so in `AUTOPILOT_DONE`. Never let a general-purpose-only review pass as
a fleet one.

**Dispatch every finder read-only, and check the tree after each round.** Finders inherit Edit and
Write, and one will sometimes implement a fix mid-round, so the refutations confirm findings about
code nobody pushed. Open every
finder prompt with: no Edit or Write, no git state changes, fixes described in prose only, and no
permission to run `gh pr review` or `gh run rerun` (a finder once posted its own verdict marker and
turned the gate green on a superseded verdict). After each round, `git status --porcelain`; a dirty
tree is an aborted round — restore with `git checkout -- <paths>` and say in the review that a round
was discarded. Subagents may also be denied commands you can run, so run the suite yourself and hand
them the result.

**`codex` follows config §3 `codex-review`.** Where it is `yes`, `Bash(codex:*)` and its resolved
absolute path are in the worker allow-list and the spawn preflight asserted `CODEX=OK` before you were
launched, so pullbot's Phase 4 is a **real cross-vendor refutation** and findings are **not** tagged
`(same-vendor)`. The CI gate requires `vendor=codex-cross`. Where your prompt lists `codex-review` as
denied, the user has not agreed to send diffs to OpenAI: never call `codex`, skip Phase 0, refute with
`ada-devils-advocate`, tag every finding `(same-vendor)`, and say in `AUTOPILOT_DONE` that the PR
cannot pass the gate for that reason.

**Keep every codex call a single `codex`-prefixed command.** `dontAsk` allows a command only when
every part of it matches an allow rule, so the moment a call grows a `$(mktemp)`, an `if`, a pipe or a
`timeout` wrapper, `Bash(codex:*)` stops covering it and the harness refuses the whole thing before
the shell runs — silently. That is the call being shaped wrong, not codex failing. Phase 0:

```bash
codex exec --sandbox read-only "Reply with exactly: CODEX_OK"
```

- Exit 0 — proceed, cross-vendor, untagged. `codex login status` proves nothing: it reports logged in
  on a seat that is out of usage.
- Non-zero with an error — the seat is out of usage (the error names a reset date; "start a free
  trial of Plus" means a personal seat, not the team one) or the model is at capacity.
- **No output at all** — the harness denied it (the call was compound), or codex is reading stdin.
  Fix the call shape, and add `< /dev/null` if it printed `Reading additional input from stdin`.

**Refutation prompts: one finding per call, under ~800 characters, mechanism stated flat.** Name the
`file:line` and let codex read the file; never paste a diff or ask it to run `git show`. A large
prompt hangs `codex exec` for as long as it is allowed to run, heartbeating into your log so the
orchestrator cannot see the stall. Never offer a benign alternative ("or is this deliberate?") —
codex rejects when uncertain, so that clause can flip a CONFIRMED P1 to REJECTED with no code
change. Never pass `-m`. A useless or empty reply counts as REJECTED and says the refutation did
not run, not that it passed.

You cannot answer a question, so **do not let Phase 0 stop you.** If codex is genuinely unusable
after a correctly-shaped call, fall back to `ada-devils-advocate`, tag every finding `(same-vendor)`,
and say in `AUTOPILOT_DONE` which outcome you saw — the PR will not pass the gate, and the
orchestrator needs to know why. Never tag a run `(same-vendor)` that actually refuted with codex, and
never claim codex on a run that fell back. Bound the probe at ~120s by your tool timeout.

**There is no approval block here** — that gate belongs to a session with a human in it. Instead:

- **P0, P1 or P2** — fix it, and say in `AUTOPILOT_DONE` what it was and what you did.
- **Then run it again.** Your fix is itself unreviewed code, so only a full round that finds nothing
  has reviewed everything. Keep going until a round comes back with **no P0, no P1 and no P2**. Three
  rounds is the ceiling — if findings are still arriving on the fourth, park with them named. Say in
  `AUTOPILOT_DONE` how many rounds ran.
- **A P0 you cannot fix** — park, naming the finding and its `file:line`. Do not push a branch
  carrying a P0 you have understood and left.
- **Do not defer a P2.** The CI gate fails on any non-zero `deferred`, so a deferred finding is a PR
  that can never merge. Cost the fix before calling it out of scope — a "restructuring" is often
  ~30 lines. Fix it where it stands. **A fix that grows parks**: one needing a new file other
  than its own spec, or a file your diff does not already touch, is the user's call to widen the PR
  or split it out, so park naming it. So does a fix that needs someone else's decision.
  Moving equivalent sites onto a helper this PR creates or fixes is not growth. Migrate them all,
  or list each one under *Not migrated* in the PR body. Growth means new behaviour, not new call
  sites.
- **Requirement gaps** — report in `AUTOPILOT_DONE` and in the verdict's `gaps=`, do not act. A gap
  keeps the PR in draft until the user decides; the orchestrator routes it.
- **Nothing found** — say so with the count of files reviewed. It goes in the PR's Testing bullet
  per `desk-pr`, carrying the SHA and any `(same-vendor)` tag.

**Post the report to your PR** where config §3 `pr-self-review-comment` is `yes` (otherwise park
with the report). After
`gh pr create --draft`, submit it as one `COMMENTED` review. Its first line is exactly
`<!-- pullbot:local -->` and its second the verdict marker pullbot emits
(`<!-- pullbot:verdict v=1 sha=<full headRefOid> p0=… p1=… p2=… deferred=… gaps=… vendor=… rounds=N -->`).
A later fix-up reply opens with `<!-- pullbot:reply -->` and carries no verdict — it posts at a head
nothing has reviewed. **Never post a second verdict at a commit that already has one with different
counts**, and never edit a posted verdict's counts: the gate reads the last one, so a re-count is
indistinguishable from editing the result until it passes. A wrong count needs a new run.

```bash
gh pr review <n> --repo Sophos-Education/studia-web --comment --body-file <report>
```

**Use the plain form above — never a `GH_TOKEN=… gh pr review …` prefix.** Any `VAR=value cmd`
prefix is denied by the worker permission policy, so the token-prefixed form pullbot may print is
refused *before it runs*. Plain `gh` already authenticates as the user (config §1 "GitHub handle").
The prefixed form leaves a draft PR carrying **no** review while its `AUTOPILOT_DONE` reports the review as run. **A refused `gh` call is not a finding about your permissions — strip the `VAR=` prefix
and retry before concluding anything.** If the retry also fails, that is a park.

The reviewer (config §4) reads findings on the PR. A clean run posts too — absence of a review has to mean *not
reviewed*. **Never `--approve` or `--request-changes`**, and never post a P0 you have left in place.
After posting, list the PR's reviews and confirm exactly one verdict marker exists at your head.

**The review comment is part of the terminal state.** A PR without it is unfinished: report
`pr=<n> review=NOT POSTED` in `AUTOPILOT_DONE` rather than a bare `pr=<n>`.

**If `/pullbot` does not resolve**, your worktree predates it. Do §4's rebase check now, and review
afterwards. Either way, say in `AUTOPILOT_DONE` whether the review ran; silence reads as reviewed.

## 4. Before you push: rebase

Main moves while you work. `git fetch origin`, and if `git rev-list --count HEAD..origin/main` is
non-zero, probe with `git merge-tree --write-tree origin/main HEAD | grep -c '^CONFLICT'` — without
touching the tree. Clean → rebase, then **re-run typecheck and your specs**. Any conflict → park,
naming the files.

## 5. What the orchestrator owns, not you

- **Your port and your database** are assigned in your briefing. Never the user's own dev-server
  port. Never repoint `DATABASE_URL` — it already points at your own per-ticket database.
- **Uploading images to the PR.** You capture; the orchestrator uploads. One shared signed-in browser
  profile means uploads must be serialised. Capture per `desk-ticket` Stage 5 and build the table
  per `desk-pr` — **not optional when anything renders differently** — into the screenshot
  directory named in your briefing (an absolute path ending `/.desk-autopilot/images/SV-XXX/`),
  then print `AUTOPILOT_IMAGES: <that absolute path>`, copied exactly. That directory is one you can `Read` back, so **look at every shot
  before you print the marker**: a cookie banner, a fixed navbar or an empty element is not evidence.

  Leave the image cells as `_drag <file>_` placeholders, but **leave nothing else**: no "delete this
  row once the images are in", no TODO. The body ships to a reviewer as written.

  `desk-pr`'s screenshot references carry the routes and their gotchas — follow them rather than
  improvising. Three that bite workers: seed the consent cookie or the banner covers the content;
  take the "before" with `git checkout HEAD~1 -- <path>`, **never `git stash`** (it is shared across
  every worktree); and real data needs `bun --conditions=react-server prisma/seed.ts --rich` from
  `packages/studia-web`, against your own database. "I could not seed" is not a reason to skip
  evidence.
- **Opening the PR as a DRAFT.** `gh pr create --draft --body-file <file>`. Never open a
  ready-for-review PR, and never mark one ready — `gh pr ready` is denied to you. A non-draft PR
  notifies the reviewer **the moment it opens**, before the orchestrator has uploaded your
  screenshots, and pulls the reviewer to evidence tables still full of placeholders. The orchestrator undrafts once the review at head is clean, the
  evidence is in, and config §3 allows it.

  **Write the body to a file inside your worktree** — `pr-body.md` at its root, removed afterwards
  with `git clean -f pr-body.md`. Do **not** pipe it via a `--body-file -` heredoc: that can fail
  with the body existing only in the transcript, leaving the branch pushed and **no PR at all**.

  **If the PR still cannot be opened, that is a PARK, never a done.** Print the body between
  `AUTOPILOT_PR_BODY_BEGIN` / `AUTOPILOT_PR_BODY_END` markers on their own lines so the orchestrator
  can recover it verbatim, then park naming the branch and the exact command that failed. A pushed
  branch with no PR is invisible to `desk-clearance` and to every reviewer.

  **Name every step you did not reach, not just the one that failed.** A park lists the whole
  remaining tail — PR, review comment, Jira comment, Jira transition — because the orchestrator has
  no way to infer which were still ahead of you — otherwise it opens the PR and leaves the ticket
  in `In Development`.
- **Merging.** Never. Your terminal state is a draft PR with its review posted.

## 6. Command forms that are silently denied

Permission rules match the string you write, not the file it resolves to. Prefer the plain form:

- `desk-jira …`, `codex …` — plain names; no `VAR=value` prefix on anything
- `bun run --filter <pkg> <script> -- <args>` from the worktree root — `cd` inside a compound
  command is refused. `PORT=3008 bun run dev` is refused; `bun run --filter studia-web dev -- --port 3008` works
- `bunx` is denied: run a TS script with `node <worktree>/node_modules/tsx/dist/cli.mjs <file>.ts`
  (prefer this for anything touching Prisma — bun's WASM query compiler crashes on nested writes) or
  `bun --conditions=react-server <file>.ts`
- No `$( )` substitution, no output redirection (`> file`), no loops in a command that must succeed
- `rm` is denied: `git clean -f <paths>` (or `-fdx` for directories) removes scratch files and proves the tree is clean
- `curl` is denied: drive a page with Playwright rather than probing it over HTTP
- Scratch scripts go at the worktree root and get `git clean`ed; `/tmp` is readable, not writable

If something is refused, try the plain form once before concluding you lack the capability.

## 7. Reporting

Nobody is reading live, so drop the running commentary. One line at each stage boundary, at the
**start of a line** and never inside a code fence — the orchestrator greps for these:

```
AUTOPILOT_STAGE: 4/9 verify
AUTOPILOT_NOTE:  <a discovery a sibling ticket in this batch would want>
AUTOPILOT_IMAGES: <the absolute screenshot directory from your briefing>
AUTOPILOT_PARK:  <question>
AUTOPILOT_DONE:  pr=<number> jira=<status>
```

Emit `AUTOPILOT_STAGE` **as you reach each stage**, not batched into your final message — a worker
that reports only at the end is indistinguishable from one that has wedged.

`AUTOPILOT_NOTE` matters: you are isolated from the other tickets, so a helper you just found or
wrote is invisible to them, and two workers adding the same helper is a defect by this repo's own
rules.

## Review-sweep tasks: the comment is the deliverable

If your task is reviewing a PR rather than implementing a ticket, the job is not finished when the
findings are fixed — it is finished when a `/pullbot <n> --comment` review carrying the
`<!-- pullbot:local -->` marker is visibly on the PR at the head you pushed. Post it even when the
review is clean; post it even when findings survived the round cap, naming what is left. Post it
after your final push, never before, then re-read the PR and confirm it is actually there before you
claim `posted=yes`.

The only two times you do not post: the PR had already merged or closed, or you are in a dry run
(your head is unpushed, so the review would attest a SHA that is not on origin — say so instead).
