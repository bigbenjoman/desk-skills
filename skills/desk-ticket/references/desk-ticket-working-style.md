# Working style, branch and git

The standing conventions for ticket work. Every rule here came from a real review comment or
correction. An `L-NNNN` is the learning in studia-web's `.agents/knowledge/domains/` that holds the
fact behind a rule; grep for the id when you need the detail.

## Working style

- Do the minimum that correctly solves the ticket. If there's a simpler way, take it.
- Comments state a current invariant in one to three lines. Never ticket IDs, names, dates, review
  rounds, 'previously', or failed attempts. History goes in the PR body.
- Prefer the standard utility scale to arbitrary values (`z-40`, not `z-[45]`).
- Match the surrounding code's conventions.
- Flag anything that looks wrong in the ticket, or any scope you think should be split into a
  follow-up, rather than silently expanding.
- **Absence is a claim.** Before concluding a helper or symbol does *not* exist, `git fetch` and
  `git grep <symbol> origin/main -- <paths>`. A stale local tree answers "no such symbol" and reads
  as careful verification, and can miss a helper that landed on `main` minutes earlier — the way a
  duplicate copy of a predicate gets written.
- **Copy you draft** — SEO titles and descriptions, marketing text, i18n strings — gets no em dashes
  or similar flourishes; plain sentences, commas, full stops. Copy transcribed from Figma or supplied
  by design ships verbatim.
- **Placeholder content in a design does not block the build.** Build with the placeholders in as
  real i18n keys, so the follow-up is copy-only, and raise **one** spin-off ticket for every gap,
  linked `Relates`.
- **Legal or compliance content is findings-first.** Deliver the recommended change as a Jira
  comment and split implementation into a follow-up that waits for team sign-off, even when the fix
  is tested. When a legal change does ship, bump `LEGAL_LAST_UPDATED[<slug>]` in the same commit as
  the prose (L-0215).

## Branch and git

- Branch off up-to-date `main`.
- Naming: `<type>/SV-XXX-short-desc`, where `<type>` is the conventional-commit type the PR title
  will carry — `fix/` for Bugs, `feat/` for Tasks and Stories, `chore/` for lane E data work. It is
  `fix/`, **not** `bugfix/`, even for a Jira "Bug", and `feat/` rather than `feature/`, as
  CLAUDE.md words it `<type>/`. The `feature/*` branches still on the remote are legacy and not a
  counter-example.
- **Uppercase the key in the branch name.** `.githooks/prepare-commit-msg` reads it from there and
  GitHub pre-fills the PR title from it; Jira only matches `SV-123`, never `sv-123`. A branch with
  no key at all — `worktree-*`, `agent-*` — gives the hook and the title nothing to work with.
- The Jira issue type decides the prefix. Sibling branches (`git branch -r`) are advisory — check
  them, but don't let one odd sibling override the type rule.
- Commit and push as the user (config §1 git identity), with no AI attribution (config §5).
- Commit subjects take the same shape as the PR title — `type(scope): SV-XXX description`, with
  the key uppercase and immediately after the colon. Only the PR title reaches `main` (squash-only),
  so the commit itself is assistive rather than gated, and `.githooks/prepare-commit-msg` splices
  the branch's key in for you once `bun install` has run its `hooks:install` postinstall. See
  `desk-pr` for the full rule and the type list.
- Commit when it makes sense; push the branch when the work is done and the diff has been shown.

## Worktrees

Several Claude sessions may run against this repo at once. Use a worktree when another session's
lock is live, or for lanes C and D. Worktrees live under config §2's worktrees directory.

Never check out, commit to, rebase, or delete a branch or worktree you did not create. `git
worktree list` will show others; they belong to other tickets.

Run dev servers in the ticket's own worktree, not the main checkout. A typecheck error whose path
starts `.next/dev/types/` is another branch's route types: `rm -rf packages/studia-web/.next/dev/types`
and re-run (L-0214).

## Generated files — they lie quietly

- **After a full `bun run test`**, `git checkout --`
  `apps/studia-docs/content/studia-web/reference/trpc-routers.mdx` and re-check `git status` (L-0210).
- **Regenerate docs with `bun run docs:gen-trpc` / `docs:gen-env`, never `bunx tsx`**, which writes
  nothing and exits 0 (L-0211). Skip a regeneration whose only diff is the stamp line.
- **`openapi:gen` uses whatever server holds :3000** (L-0212). Point it at your own:

  ```bash
  lsof -nP -iTCP:3011 -sTCP:LISTEN || bun run next dev -p 3011     # from packages/studia-web
  OPENAPI_BASE_URL=http://localhost:3011 bun run --filter studia-web openapi:gen
  ```

  Any deletion in the `admin-api.json` diff is wrong until proven otherwise. Never kill a server in
  another worktree.

## Evidence (Stage 5)

- **Stage the "before" with `git checkout HEAD~1 -- <path>`**, restore with `git checkout HEAD --
  <path>`. Never `git stash` after committing: it no-ops (and wrappers may still print "stashed"),
  and stashes are shared across every worktree. Grep the file for the changed value between shots
  rather than trusting either command's output.
- **Don't mutate the shared local database for evidence.** Create a throwaway per-ticket database
  in the local Postgres container, point this worktree's `DATABASE_URL` at it (same credentials,
  different database name), `prisma migrate deploy` and seed, then toggle rows to stage "before".
  Running the migration's own SQL for "after" doubles as proof it does what it claims. Leave these
  databases in place; cleanup reports them rather than dropping them.
- **Start the dev server on a free port** (config §3b "Preferred dev-server port", or pick one), never assuming
  3000 — capturing someone else's server captures another branch's code.
- Seed the `CookieConsent` cookie before the first `goto` and hide `nextjs-portal`, or both overlay
  the UI (`desk-pr/references/screenshot-surfaces.md`).
- Drive the worktree's own `playwright` package from a script in your scratchpad, never one inside
  the repo, under `~/.claude/desk/bin/with-lock.sh browser …`.

## Diff hygiene — before the PR

Every one of these has been a real review comment or correction:

- Is every changed file necessary for this ticket? Stray files are the most common complaint.
- No one-off scripts in the PR. House rule: run the script once from the branch, then delete
  it — it doesn't need to reach `main`.
- No verbose comment blocks. One short human line where it genuinely helps, otherwise none.
- No tests that weren't asked for, and no test that hardcodes the example from the ticket when
  the fix is meant to be general.
- No `.playwright-mcp/`, screenshots, restamped generated pages, or other artefacts. `git status`
  clean.
- No JWT-shaped literal (`eyJ…` base64url segments) in a spec: the blocking SAST job flags the shape
  and nothing local runs Semgrep. Build fixtures by concatenation (L-0213).
- Would this survive review? Reviewers here reject verbose comments and missing specs, and want
  before/after screenshots on UI changes. See config §4 for who reviews and what they ask for.

## Keep them posted while you work

People run several sessions at once and need to know where each one is without asking.

- **Say what you're about to do** before any step that will take more than a minute or two — a
  staging clone, a `bun install`, a subagent run, a long search. Name it and say roughly what it
  involves.
- **Report at every stage boundary**, not only at the end. One or two lines: what just finished,
  what's next.
- **Surface findings when you find them**, not batched into a final summary — especially anything
  that changes the plan, contradicts the ticket, or means the lane was wrong.
- **Say immediately when something unexpected happens.** Don't work around it quietly and mention
  it later. A blocker heard about at the time costs a question; one heard about at the end costs the
  work. If a step was skipped, failed or only partly worked, say so in those words.
- **Any uncertainty is a question**, not a sensible default to carry on with.
- **A question from the user is not authorisation.** "Should we…?", "Is it worth…?" open a
  discussion; answer with a proposal, not a file write.
- **Never go quiet for a long stretch.** If a step is genuinely slow, say it's running and what
  you're waiting on.
- Keep each update to a line or two. This is a running commentary, not a report — brevity is what
  makes it readable while they are doing something else.

## Jira comments

Keep them short and plain. Three parts, nothing more:

1. Root cause, one sentence.
2. The fix, one sentence.
3. The PR link.

Then the `SV-XXX/desk-ticket` marker. No headings, no bullet lists, no verification
logs, no test counts, no merge or coordination notes — those belong in the PR body, where
the reviewer is actually looking. Plain sentences, not a report.

If something genuinely needs the team's attention and isn't a review matter, that is its own
short comment or a direct message to the relevant person (config §4), not an extra section bolted
onto this one. Messages to people are drafts for the user to send.

## Anything the user needs to see

Put files where they can open them: `<handoff dir>/SV-XXX/` (config §2). On WSL that directory must
be Windows-visible, because Windows can't read WSL paths conveniently.

Personal or working documents — findings, audits, notes — do not belong in the repo. They go to the
handoff directory or wherever the user keeps their own documents.
