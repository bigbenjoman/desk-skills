# Working style, branch and git

The standing conventions for ticket work. Every rule here came from a real review comment or
correction. Where a rule depends on a fact about this repo, it names the config row (this repo's
config, resolved with `desk-env where`) or the §5 Repo instructions files that carry it; those files
win on anything they cover. `<TICKET>` is the ticket key: a tracker key, an §4 Other work id patterns id, or with §4 Tracker
`none` the `issue-<n>` or slug `desk-ticket` settled at Stage 0. `<default>` is §0 Default branch.

## Working style

- Do the minimum that correctly solves the ticket. If there's a simpler way, take it.
- Comments follow §5 Code comments. Where that row is silent: comments state a current invariant in
  one to three lines. Never ticket IDs, names, dates, review rounds, 'previously', or failed
  attempts. History goes in the PR body.
- Prefer the design system's standard scale to arbitrary values (a utility class's scale step, not a
  one-off bracketed value).
- Match the surrounding code's conventions.
- Flag anything that looks wrong in the ticket, or any scope you think should be split into a
  follow-up, rather than silently expanding.
- **Absence is a claim.** Before concluding a helper or symbol does *not* exist, `git fetch` and
  `git grep <symbol> origin/<default> -- <paths>`. A stale local tree answers "no such symbol" and
  reads as careful verification, and can miss a helper that landed on `<default>` minutes earlier:
  the way a duplicate copy of a predicate gets written.
- **Copy you draft** follows §5 User-facing copy you write. Where that row is silent: SEO titles and
  descriptions, marketing text, translation strings get no em dashes or similar flourishes; plain
  sentences, commas, full stops. Copy transcribed from a design or supplied by the designer or
  product owner ships verbatim.
- **Placeholder content in a design does not block the build.** Build with the placeholders in as
  real copy keys (the repo's i18n keys, where it has i18n), so the follow-up is copy-only, and raise
  **one** spin-off ticket for every gap, linked `Relates` (with no tracker, list the gaps in the PR
  body for the user to raise).
- **A ticket you file follows the desk ticket template.** A spin-off, the follow-up of a legal
  finding, or any other ticket this ticket's work raises uses desk-jira's
  `references/ticket-template.md` for its type (or §5 Ticket format's own sections, where it names
  them), written through `desk-jira`'s gate. Its criteria are ones the next worker can do. Its
  dependency on this ticket is a link, not a sentence.
- **Legal or compliance content is findings-first.** Deliver the recommended change as a ticket
  comment (with no tracker, as findings to the user) and split implementation into a follow-up that
  waits for team sign-off, even when the fix is tested. When a legal change does ship, any
  last-updated stamp the repo keeps for that document moves in the same commit as the prose.

## Branch and git

- Branch off up-to-date `<default>`.
- Naming follows §5 Branch names. Where it uses a type prefix, the prefix is the conventional-commit
  type the PR title will carry, taken from the issue type: typically `fix/` for bugs, `feat/` for
  features, tasks and stories, `chore/` for lane E data work. Use the prefix the row gives exactly
  (`fix/`, not `bugfix/`, where the row says `fix/`). Old branches still on the remote under another
  scheme are legacy and not a counter-example.
- **Use the key exactly as §4 Ticket key pattern writes it, in the branch name.** Jira matches the
  key only in its canonical case (`ABC-123`, never `abc-123`), and a commit-message hook or GitHub's
  PR-title prefill may read it from there. A branch with no key at all (`worktree-*`, `agent-*`)
  gives the hook and the title nothing to work with. A work id (§4 Other work id patterns) goes in
  exactly as given, case kept; with Tracker `none`, `issue-<n>` or the slug goes where the key would.
  Once the branch exists, it stays: the PR is found by its exact head branch.
- The issue type decides the prefix. Sibling branches (`git branch -r`) are advisory: check
  them, but don't let one odd sibling override the type rule.
- Commit and push as the user (config §1 "Git author name / email"). AI attribution follows §5 AI
  attribution: where it is `forbidden`, no `Co-Authored-By` trailer, "Generated with" line or robot
  emoji anywhere.
- Commit subjects take the same shape as the PR title (§5 PR title), with the key where that
  convention puts it. Where §4 Merge method is `squash`, only the PR title reaches `<default>`, so the
  commit subject is assistive rather than gated; a repo hook may splice the branch's key in for you
  once §4 Install has installed its hooks. See `desk-pr` for the full rule and the type list.
- Commit when it makes sense; push the branch when the work is done and the diff has been shown.

## Worktrees

Several Claude sessions may run against this repo at once. Use a worktree when another session's
lock is live, or for lanes C and D. Worktrees live under config §2's Worktrees directory.

Never check out, commit to, rebase, or delete a branch or worktree you did not create. `git
worktree list` will show others; they belong to other tickets.

Run dev servers in the ticket's own worktree, not the main checkout. A typecheck error whose path is
inside a framework's generated-types directory in the build output (e.g. a dev server's route
types) is usually another branch's generated types: delete that generated directory in your own
worktree and re-run.

## Generated files — they lie quietly

- **After a full test run, check `git status` for generated files the run restamped** (reference
  docs, snapshots, lockfile-adjacent stamps) and `git checkout --` any you did not mean to change.
- **Regenerate through the repo's own script** (the one §5 Repo instructions or the package scripts
  name), never an ad-hoc runner invocation of the generator: that can write nothing and exit 0. Skip
  a regeneration whose only diff is a timestamp or stamp line.
- **A generator that reads from a running server uses whatever server holds the default port.**
  Point it at your own, started in your worktree on a free port, never at one another worktree
  holds. Any deletion in a generated API spec's diff is wrong until proven otherwise. Never kill a
  server in another worktree.

## Evidence (Stage 5)

- **Stage the "before" with `git checkout HEAD~1 -- <path>`**, restore with `git checkout HEAD --
  <path>`. Never `git stash` after committing: it no-ops (and wrappers may still print "stashed"),
  and stashes are shared across every worktree. Grep the file for the changed value between shots
  rather than trusting either command's output.
- **Don't mutate a shared local database for evidence.** Where §4 Local database is set and config §3
  `db-per-ticket` allows, create a throwaway per-ticket database the way that row describes, point
  this worktree's database URL at it (same credentials, different database name), run the repo's
  migrations and seed, then toggle rows to stage "before". Running the migration's own SQL for
  "after" doubles as proof it does what it claims. Leave these databases in place; cleanup reports
  them rather than dropping them. With §4 Local database `none`, there is no per-ticket database:
  stage the "before" from code alone, or say what could not be staged.
- **Start the dev server on a free port** (config §3b "Preferred dev-server port" if it is free, or
  pick one), never assuming the default: capturing someone else's server captures another branch's
  code.
- Dismiss consent banners and hide framework dev overlays before the first capture, or both overlay
  the UI (`desk-pr/references/screenshot-surfaces.md`).
- Drive the worktree's own `playwright` package from a script in your scratchpad, never one inside
  the repo, under `~/.claude/desk/bin/with-lock.sh browser …`.

## Diff hygiene — before the PR

Every one of these has been a real review comment or correction:

- Is every changed file necessary for this ticket? Stray files are the most common complaint.
- No one-off scripts in the PR. Run the script once from the branch, then delete it: it doesn't
  need to reach `<default>`.
- No verbose comment blocks. One short human line where it genuinely helps, otherwise none.
- No tests that weren't asked for, and no test that hardcodes the example from the ticket when
  the fix is meant to be general.
- No `.playwright-mcp/`, screenshots, restamped generated pages, or other artefacts. `git status`
  clean.
- No secret-shaped literal (a JWT's `eyJ…` base64url segments, a key-shaped string) in a spec, where
  CI runs secret or static-analysis scanning (§4 Required checks and Advisory checks name them):
  scanners flag the shape and usually nothing local runs them. Build fixtures by concatenation.
- Would this survive review? §4 What review here consistently asks for is the house bar, and §4
  People names who reviews.

## Keep them posted while you work

People run several sessions at once and need to know where each one is without asking.

- **Say what you're about to do** before any step that will take more than a minute or two: a
  staging clone, a §4 Install, a subagent run, a long search. Name it and say roughly what it
  involves.
- **Report at every stage boundary**, not only at the end. One or two lines: what just finished,
  what's next.
- **Surface findings when you find them**, not batched into a final summary, especially anything
  that changes the plan, contradicts the ticket, or means the lane was wrong.
- **Say immediately when something unexpected happens.** Don't work around it quietly and mention
  it later. A blocker heard about at the time costs a question; one heard about at the end costs the
  work. If a step was skipped, failed or only partly worked, say so in those words.
- **Any uncertainty is a question**, not a sensible default to carry on with.
- **A question from the user is not authorisation.** "Should we…?", "Is it worth…?" open a
  discussion; answer with a proposal, not a file write.
- **Never go quiet for a long stretch.** If a step is genuinely slow, say it's running and what
  you're waiting on.
- Keep each update to a line or two. This is a running commentary, not a report: brevity is what
  makes it readable while they are doing something else.

## Jira comments

For a ticket that is not a tracker key (a work id, or Tracker `none`) there are none: skip this
section. Otherwise §5 Ticket comment is the shape;
by default, short and plain, three parts, nothing more:

1. Root cause, one sentence.
2. The fix, one sentence.
3. The PR link.

Then the `<TICKET>/desk-ticket` marker. No headings, no bullet lists, no verification
logs, no test counts, no merge or coordination notes: those belong in the PR body, where
the reviewer is actually looking. Plain sentences, not a report.

If something genuinely needs the team's attention and isn't a review matter, that is its own
short comment or a direct message to the relevant person (config §4 People), not an extra section
bolted onto this one. Messages to people are drafts for the user to send (§5 Messages to colleagues;
`slack-send` is `never`).

## Anything the user needs to see

Put files where they can open them: `<handoff dir>/<TICKET>/` (config §2 Handoff directory). Where
config §2 "Running on WSL?" is `yes`, that directory must be Windows-visible, because Windows can't
read WSL paths conveniently.

Personal or working documents (findings, audits, notes) do not belong in the repo. They go to the
handoff directory or wherever the user keeps their own documents.
