---
name: desk-pr
description: >-
  Use when opening or updating a pull request in studia-web — including portal changes, which
  are studia-web PRs touching apps/portal/ — or when asked for a PR body, PR description, "the markdown for the PR", before/after screenshots for a review,
  or a check that a diff is clean enough to push.
---

# desk-pr

## Overview

Two jobs, in this order: prove the diff deserves to be a PR, then write the body.

**Core principle: the hygiene pass comes first. A tidy description of an untidy diff still gets
sent back.**

**Read `~/.claude/desk-config.md` first** — §1 for the GitHub handle, §2 for the handoff directory
screenshots go to, §3 for whether you may push (`git-push`), open a PR (`pr-open`), edit its body (`pr-edit`), upload
images (`pr-images`), undraft (`pr-ready`) or arm auto-merge (`pr-auto-merge`), §4 for the code
reviewer and the Vercel, infra and security owner, §5 for the title, branch and body conventions.

## 1. Diff hygiene — produce this before writing any prose

```
DIFF REVIEW — <recorded | awaiting approval>
commits ahead : <git log --oneline origin/main..HEAD>
files changed : <n>  <list>
artefacts     : <git status --porcelain, or "clean">
scripts       : <any one-off script in the diff, or "none">
unasked tests : <any spec not required by the ticket, or "none">
docs          : <pages citing a changed file, or "none">
infra         : <infra paths touched, or "none">
siblings      : <helper → n sites migrated, m under Not migrated | none>
unrelated     : none | <files> → own PR
self-review   : <P0/P1/P2 counts at <sha> · refuted by <codex|same-vendor> + any caveat, or "not run — why">
```

Then check each line against these. Every one has been a real review comment or correction:

- **Only your commits.** If `origin/main..HEAD` contains anything from another session, stop —
  don't push. Report the stray SHAs and offer to move your work onto a clean branch. This check
  always hard-stops, whatever §3 says about pushing.
- **Every file necessary.** Stray files are the single most common complaint on PRs here.
- **No one-off scripts.** House rule: run the script once from the branch, then delete it. It
  does not need to reach `main`.
- **No unasked-for tests**, and no spec that hardcodes the ticket's example when the fix is
  meant to be general. The inverse also holds: a new helper or regex with no spec gets sent back.
- **Comments short and human**, or absent. No verbose AI-style blocks.
- **No hardcoded value where an env var already exists**, and no change unrelated to the ticket —
  both are recurring review questions.
- **No artefacts** — `.playwright-mcp/`, loose `.png`/`.jpeg`, scratch files, preview pages,
  temporary `publicRoutes` entries, a patched Storybook mock.
- **Docs.** Every PR carries its own docs update. Work it out
  from the diff — `docs:check-staleness` dates each page against its sources' last commits, so it
  reports a feature branch as clean and will never tell you. Two checks:
  - `grep -rl "<changed path>" apps/studia-docs/content` — the `<SourceLink>` footers cite
    repo-relative paths, so a path straight from `git diff --name-only` matches, and a cited
    directory covers everything beneath it.
  - `packages/studia-web/.env.example`, `src/server/api/routers/` and `prisma/schema.prisma` feed
    the generators. Regenerate with `bun run docs:refresh` or the individual `docs:gen-*` scripts,
    never `bunx tsx` (L-0211), and discard a diff that is only the "as it stood on" stamp.

  What a change set breaks is nearly always a count: procedures, CDK stacks, env vars, allowlist
  entries. Prose about a mechanism usually survives, so read the claim before assuming it broke.
  A generated page quotes its source, so a stale comment is a source fix, not a page edit. Fill
  the `docs` slot and **wait** — rewriting a page is the user's call. "None" is a real answer.

- **Infra.** "Touches infra" means `packages/studia-web/infrastructure/**`, any CDK stack,
  `packages/{chat,crm,moderation,shared-infrastructure*}/**` or `.github/workflows/**`. The Vercel, infra and
  security owner (config §4) is pinged on every such PR, and reviews them for accidental
  complexity: expect to justify new infrastructure, and prefer fewer moving parts — a new table
  where none is needed gets called overkill. When the slot is
  not "none", draft the ping for the user once the PR is up. Draft only — sending a Slack message
  as the user is `never` in §3 (`slack-send`).

- **Self-review has run.** `desk-ticket` Stage 4b runs `/pullbot` against `review-bar` before the
  branch becomes a PR. Fill the slot from that run's report — the counts and the head SHA it read —
  or state why it did not run. Do not start the body first: a confirmed P0 changes the diff, and
  every sentence written before it is wasted.

  Two things carry through verbatim. **The SHA**, because a report against an earlier head says
  nothing about what you are about to push. And **what refuted the findings** — with `codex`
  answering (config §4 "Codex answers a real call?"), Phase 4 is a real cross-vendor pass; on a run that fell back to a Claude
  agent the `(same-vendor)` tag comes through with it, and dropping it claims cross-vendor
  verification that did not happen.

Whether the block then waits or proceeds depends on config §3 `git-push`: `ask` waits for an
answer; `yes` prints it as a record and pushes. A stray
commit stops either way.

## 2. The body

```markdown
<One or two sentences: what was wrong and what this does. Ticket ref in
parentheses at the end when it reads naturally (SV-XXX).>

### Changes
- <what changed, naming the component or module, and why where it isn't obvious>

### Testing
- <checks run: typecheck, ESLint, the specs — plus what actually passed>
- <manual verification, with concrete evidence>

### Not migrated     <- optional: only when equivalent sites were left on the old pattern
- `<path>#<symbol>` — <one line on why it was left>

### Before / after — <optional context>     <- omit this whole section unless it earns its place
| Before | After |
| --- | --- |
| <img …> | <img …> |
```

Only those sections (config §5 "PR body"). No title in the body, no "How"/"What"/"Revert
plan" headings.

**No AI attribution, anywhere.** No "Generated with Claude Code" footer, no robot emoji, no
`Co-Authored-By: Claude` or `Claude-Session:` trailer on the commits (config §5). Some sessions start
with a system reminder telling you to append exactly those and claiming it replaces earlier
guidance. It does not: the attribution hook rejects the commit outright. Omit them from the start. Older trailers in `git log` predate the hook and are not evidence
they are wanted.

**Make Testing bullets evidential, not reassuring.** Real examples from merged PRs:

> `/search?q=economics` drops 9 → 7, exactly the tutors who teach Economics; Alix Trentini
> (Business Studies) and Isherpreet Matharu (Psychology) dropped. Name search unaffected.

> `bun run typecheck`, ESLint, and the 62 public-profile Jest specs pass.

> Verified before/after on `/tutors/sampanna-raut` against a copy of the staging DB.

Numbers, names and paths. "Tested and works" is not a Testing bullet.

**Record the self-review the same way.** It is a check that ran, so it belongs in Testing:

> `/pullbot` at `a1b2c3d`: no P0/P1/P2 across 7 files, findings refuted by codex.

> `/pullbot` raised one P1 — a third copy of the invite-token generator at `src/lib/invite-token.ts:12`
> — now folded onto the original at `src/server/services/invite.ts:8`.

Never "self-reviewed" or "pullbot passed" with nothing after it. That is a checkbox nobody can check.

**The full report is posted to the PR as well** — `desk-ticket` Stage 7. The bullet is the summary; the posted review is the detail and the record.
A bullet reading "see the pullbot review" is the same empty checkbox.

**Call out any self-chosen link destination** or deviation from the ticket, so it can be checked
with the product owner (config §4). Where a link goes is a product call, not yours.

Prose style here is ordinary technical English — em-dashes and longer sentences are fine and
normal in PR bodies (config §5 "PR body"). That differs from the register
for messages to people in `desk-review-response/references/voice.md`; don't carry one into the other.

### Say it simply, without saying less

Nearly every PR draft has come back with "less verbose", "simpler language", "make it easier to
read". That feedback is about the **prose**, not the content.

- short sentences, plain words, one idea per bullet
- name what changed, not the journey to finding it
- cut hedging, restatement, and anything the diff already shows

> ✗ In order to address the issue described in the ticket, this change modifies the way in which
> the search query is constructed so that it no longer includes the free-text biography field…
>
> ✓ Subject search matched tutors on their bio, so anyone who mentioned a subject in prose
> surfaced. Now matches name + subjects only.

**But do not lose information.** Compress how it is said, never what is said. Still required:

- every distinct change, and why where it isn't obvious from the diff
- what was verified, with the number, path or name that proves it
- any caveat, knock-on effect, or thing deliberately left out of scope
- a dependency on a PR that hasn't merged

A reviewer should never have to ask "and what about X?" about something you knew and left out. If a
point genuinely doesn't belong in the PR, it goes in the Jira comment or a follow-up ticket — never
nowhere.

## 3. Screenshots — only when a picture shows what words can't

Include the before/after section **if and only if the change alters what someone sees on screen.**
That is the test — not "is this a frontend file".

**Include them for:** layout, spacing, colour, copy, a component appearing or disappearing — and for
result-set changes where the count or ordering *is* the point. A search-relevance change with no
visual redesign still earns the table when it shows `/search?q=economics` dropping 9 → 7.

**Leave the section out entirely for:** server, repository, tRPC or schema changes with no rendered
difference · test-only changes · config, env or CI changes · refactors that are visually identical
by design · lane E data work whose deliverable is a script.

When you leave it out, say so in one line — "no screenshots, nothing renders differently" — so it
reads as a decision rather than an omission. **An empty table, or placeholder rows on a PR that has
no images coming, is worse than no section at all.** Reviewers here expect before/after on PRs that
do change the rendering — so when it qualifies, it isn't optional.

**Keep the table small.** Match the pairs to the change: a mobile-only fix gets the mobile pair only.
Reviewers cut oversized tables on request ("do we need 24 images?").
Pick the two or three widths that carry the change, say in the line above the table that the other
widths were verified by measurement, and put the numbers in Testing. A ticket asking for "screenshots
at each breakpoint" does not override this.

**Capturing.** Playwright at the chosen widths, saved to `<handoff dir>/SV-XXX/` (config §2).
Pick the cheapest surface that renders real copy — **read `references/screenshot-surfaces.md`**
before the first capture. The two traps that ruin shots most often: the Cookiebot banner (seed the
`CookieConsent` cookie before the first `goto`) and a "before" that renders missing i18n keys
(restore the old component *and* its messages file together).

If glyphs or emoji render as monochrome tofu in headless Chromium: on WSL (config §2), copy the
Windows emoji font once — `cp /mnt/c/Windows/Fonts/seguiemj.ttf ~/.local/share/fonts/ && fc-cache -f`;
elsewhere install a colour emoji font such as Noto Color Emoji.

Then delete the Playwright script and artefacts from the repo and confirm `git status` is clean.

### The image table

GitHub has no API for PR-body image attachments, and the repo is private so `raw.githubusercontent`
links will not render for reviewers. The assets have to be minted through the web UI — by the
automated upload below, or by hand.

**Always write the body with placeholder cells first**, one row per image pair. The upload script
swaps exactly these cells, and they are also the manual fallback:

```markdown
| Before | After |
| --- | --- |
| _drag before-desktop.png_ | _drag after-desktop.png_ |
| _drag before-mobile.png_ | _drag after-mobile.png_ |
```

**Name the actual files**, exactly as they sit in `<handoff dir>/SV-XXX/`. A cell that names the
wrong file puts the wrong image in the wrong row — and a 1366 shot in the 1440 row is a review
comment. For the script, the cell must be `_drag <exact filename>_` or it is not swapped.

**Add a leading column when the pairs differ by more than before/after** — viewport width, role,
persona, whatever the axis is:

```markdown
| Width | Before | After |
| --- | --- | --- |
| 375 (stacked) | _drag before-375.png_ | _drag after-375.png_ |
| 1366 (as reported) | _drag before-1366.png_ | _drag after-1366.png_ |
```

Annotate the row that matches the reported condition, and say in one line above the table what the
rows show — including any row that is deliberately unchanged, so its identical pair doesn't read as
a mistake. For a typography change, GitHub scales both cells to the same width and hides the very
difference you are showing: set explicit `width=` on both images, scaled by the same factor, and
say so in the caption.

If the images go in by hand, **say explicitly: delete the placeholder rows once the images are in.**
Otherwise `| _drag before-desktop.png_ | _drag after-desktop.png_ |` merges still sitting above the
real images.

### Upload the images automatically

The upload drives a browser profile signed in to GitHub **as the user** (config §2 "Signed-in browser profile") against a real PR.

| Config §3 `pr-images` | What you do |
|---|---|
| `yes` | Show the block below as a record, run the upload, show the result. |
| `ask` | Show the block, **stop and wait**, every run. Silence is not approval. |
| `no` or `TODO` | Placeholder table only; hand it over for dragging. Don't offer the upload. |

```
IMAGE UPLOAD
PR         : #<n> <title>
images     : <n> files from <handoff dir>/SV-XXX/  (<list>)
method     : signed-in browser (<github handle>) uploads to the new-comment box, never submitted;
             placeholders swapped in the body with gh pr edit --body-file
```

`yes` covers this upload on the user's own PRs only. It is not a waiver of any other gate, and it
never covers speaking as the user.

**Run the script** if it is installed:

```bash
node ~/.claude/desk/bin/upload-images.mjs <pr-number> <handoff dir>/SV-XXX/
```

It uploads every png/jpg in the directory and swaps the `_drag <file>_` cells.

| Exit | Meaning |
|---|---|
| 0 | every placeholder replaced |
| 1 | bad arguments, missing dir or no images, or an unexpected crash |
| 2 | shared browser profile in use; retry later |
| 3 | uploaded, but no `_drag <file>_` placeholder matched (tags printed) |
| 4 | uploaded, but placeholders still left |
| 5 | not permitted (§3 `pr-images` not `yes`) |
| 6 | setup: browser profile unset or missing, or Playwright not installed |

On 3 or 4 fix the body by hand from the printed tags — **do not re-upload**, the assets already
exist. One session at a time: a single profile, one `SingletonLock`.

**Without the script, or when it fails in a way you have to debug**, read
`references/image-upload.md` — the manual steps and every GitHub quirk that has cost a failed run.
Whichever route, afterwards: verify placement (select images by `alt`, read `naturalWidth`), confirm
no `_drag ` cells survive, delete any `.playwright-mcp/` directory, and confirm `git status`.

The permission classifier may refuse this independently of config. That refusal is never a thing
to work around — say so and let the user decide whether to grant the Bash permission. If the
profile is signed out or signed in as someone else, stop and use the placeholder table; never
attempt a login.

## 4. Opening it

```bash
gh pr create --draft --body-file <path> --title "<type>(<scope>): SV-XXX <short description>"
```

Gated on config §3 `pr-open`. Always pass `--title` explicitly.

**Draft first.** The draft gives the images somewhere to land. Then, in order: upload the images,
post the Stage 4b self-review (`desk-ticket` Stage 7), and — if §3 `pr-ready`, `pr-auto-merge`
and `pr-merge-green` all allow — `gh pr ready <n> && gh pr merge <n> --auto --squash`. A draft cannot
merge, so a PR left drafted is a merge silently deferred; if a row says `no`, say plainly it waits on
the user. `desk-ticket`'s "Merging" section owns shepherding, including disarming auto-merge when
review feedback lands under §3 `merge-feedback-first`. If
`gh` fails, fall back to handing over the raw markdown to paste.

**The title is a conventional-commit type, then the Jira key** — `type(scope): SV-123 short
description` (config §5). CI's `pr-title` job gates it and the required check depends on it; `main`
is squash-only with `squash_merge_commit_title = PR_TITLE`, so this one string is what reaches
`main` and the only thing the Atlassian app parses for a key.

- Types: `feat|fix|chore|ci|docs|test|refactor|perf|build|style|revert`. A `!` before the colon
  marks a breaking change — `fix(web)!: SV-887 scope the public media signer`.
- The key is **uppercase** and sits **immediately after the colon**, with no colon of its own.
  `sv-123` links to nothing at all, and the legacy `SV-1107: unregister the rate limit` fails for
  putting the key before the type.
- The scope is optional and not checked against a list, but it must be lowercase
  `[a-z0-9./_-]` — **an uppercase or spaced scope fails and reports itself as a *type* error**, so
  check the scope's case before you doubt the type. Prefer a workspace (`web`, `portal`, `docs`,
  `chat`, `crm`, `moderation`, `infra`), a studia-web domain (exactly the filenames in
  `.agents/knowledge/domains/`), or a cross-cutting one (`ci`, `deps`, `db`, `studia`, `i18n`,
  `storybook`, `agents`). Omit it rather than invent one for a change spanning several.
- Genuinely ticketless work takes the **`no-jira`** label, which waives the key but still requires
  the type. That is the user's call — ask.
- The repo's `CLAUDE.md`, under "Branch names and PR titles", is the source of truth.

`pr-title` runs on `pull_request` with the default event types, and **`edited` is not one of them**.
Renaming a PR does not re-run the check, and re-running the failed job replays the *old* payload —
only a push clears a bad title. Get it right at `gh pr create`.

**The branch feeds the title.** Branches are `<type>/SV-123-short-slug` (config §5): `fix/` for a
Bug, `feat/` for a Task or Story — never `feature/` — `chore/` for data-only work, never
`bugfix/`. The key must be uppercase: `.githooks/prepare-commit-msg` splices it into commit messages
and GitHub pre-fills the title from it. A branch with no key (`worktree-*`, `agent-*`) gives both
nothing to work with.

**When one ticket ships as more than one PR**, number the parts after the key. **Digits, never
letters** — `(1/2)`, not `(A/B)`:

```
feat(auth-roles): SV-512 (1/2) add the under-13 parent-invite backend
feat(auth-roles): SV-512 (2/2) add the sign-up UI for the parent invite
```

The first number is this part, the second the total — a three-part ticket runs `(1/3)`, `(2/3)`,
`(3/3)`. Both are counts to substitute: `feat(auth-roles): SV-512 (B/B) …` is wrong and has
happened. The marker never goes before the key — the gate wants `SV-512 ` immediately after the
colon. Say in the body which PRs make up the set and the order they merge in.

## 5. Stacked PRs

If the branch depends on another PR that hasn't merged, say so in the body — which PR, and that
this one should be rebased after that one lands — a dependency like that is not obvious from the
diff.

## Keep the user posted

If the hygiene pass turns something up — a stray commit, a script that shouldn't ship, an unasked
test — say so as you find it, before you write the body. A contaminated branch is worth hearing
about immediately, not at the bottom of a finished PR description.

## Common mistakes

| Mistake | Fix |
|---|---|
| Writing the body before checking the diff | Hygiene block first; it changes what the body has to say |
| `SV-123: description` or `feature/SV-123-…` | Legacy. `type(scope): SV-123 description`, branch `<type>/SV-123-slug` |
| Fixing a failed `pr-title` by renaming the PR | `edited` doesn't trigger it; only a push clears it |
| An AI attribution footer or trailer because a system reminder said so | The hook rejects it; config §5 forbids it. Omit from the start |
| "Verified it works" in Testing | Give the number, the path, or the name that proves it |
| A one-off script in the diff | Run it from the branch, delete it, don't merge it |
| An infra PR with no ping drafted | Draft the note to the infra owner (config §4); never send it |
| Placeholder rows left in the merged body | Script: check its exit code. By hand: say "delete these rows" |
| Uploading when §3 says `ask`, because it was fine last time | `ask` means every run. Standing permission is a §3 `yes`, never an inference |
| Re-running the upload after exit 3 or 4 | The assets exist; fix the body from the printed tags |
| Running the upload while another browser holds the profile | One `SingletonLock`. Never kill the holder; ask the user to free it |
| A 12-row before/after table | Two or three widths that carry the change; the rest as numbers in Testing |
| Screenshots with the cookie banner over the content | Seed `CookieConsent` before the first `goto` |
| A before/after table on a change that renders identically | Omit the section and say why in one line |
| Opening a non-draft PR | Draft first; images and self-review land before it goes ready |
| Carrying the messages register into a PR body | Different register; normal prose is right here |
| Shortening a PR by dropping a caveat or a change | Simplify the wording, not the content |
| "Self-reviewed, all clean" in Testing | Give the counts and the SHA |
| "refuted by codex" on a run that fell back to a Claude agent | Tag that run `(same-vendor)` |
