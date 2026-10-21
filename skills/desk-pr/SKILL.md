---
name: desk-pr
description: >-
  Use when opening or updating a pull request in this repo, or when asked for a PR body, PR
  description, "the markdown for the PR", before/after screenshots for a review, or a check that a
  diff is clean enough to push.
---

# desk-pr

## Overview

Two jobs, in this order: prove the diff deserves to be a PR, then write the body.

**Core principle: the hygiene pass comes first. A tidy description of an untidy diff still gets
sent back.**

**Resolve this repo's config first.**

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no
```

Read the `CONFIG` file. `EXISTS=no` means stop: say which slug was looked up and offer `/desk-setup`.
A `TODO` in a row this skill needs is not a gap to guess: stop, ask, and offer `/desk-setup`. Then:

- §0 for the GitHub repo and default branch (written `<default>` below; read it with
  `desk-env get default-branch`, which returns an autopilot batch's base when one is set), §1 for the GitHub handle,
  §2 for the handoff directory screenshots go to.
- §3 for whether you may push (`git-push`), open a PR (`pr-open`), edit its body (`pr-edit`), upload
  images (`pr-images`), undraft (`pr-ready`) or arm auto-merge (`pr-auto-merge`).
- §4 for the tracker and ticket key pattern, the required checks, merge method, local review
  command and its clean verdict, staging, and the code reviewer and infra and security owner.
- §5 for the branch, PR title, PR body, PR lifecycle and AI attribution conventions, and
  **§5 Repo instructions**: the repo's own files (`CLAUDE.md`, `AGENTS.md`…) win over this skill on
  anything they cover. Read the parts about PRs, titles and docs before starting.

`<TICKET>` below is the key matched by §4 Ticket key pattern. With §4 Tracker `none` there is no key:
use the branch's slug wherever a path needs one, and titles carry no key.

## 1. Diff hygiene — produce this before writing any prose

```
DIFF REVIEW — <recorded | awaiting approval>
commits ahead : <git log --oneline origin/<default>..HEAD>
files changed : <n>  <list>
artefacts     : <git status --porcelain, or "clean">
scripts       : <any one-off script in the diff, or "none">
unasked tests : <any spec not required by the ticket, or "none">
docs          : <pages citing a changed file, or "none">
infra         : <infra paths touched, or "none">
siblings      : <helper → n sites migrated, m under Not migrated | none>
unrelated     : none | <files> → own PR
self-review   : <§4 Local review command's counts at <sha> · refuted by <codex|same-vendor> + any caveat, or "not run — why">
pre-push      : <passed at <sha> in <n>s, plus any item skipped on the lock | failed: <command> | not set (§4 Pre-push checks <none|unset>)>
```

Then check each line against these. Every one has been a real review comment or correction:

- **Only your commits.** If `origin/<default>..HEAD` contains anything from another session, stop —
  don't push. Report the stray SHAs and offer to move your work onto a clean branch. This check
  always hard-stops, whatever §3 says about pushing.
- **Every file necessary.** Stray files are the single most common complaint on PRs.
- **No one-off scripts.** Run the script once from the branch, then delete it. It does not need to
  reach the default branch.
- **No unasked-for tests**, and no spec that hardcodes the ticket's example when the fix is
  meant to be general. The inverse also holds: a new helper or regex with no spec gets sent back.
- **Comments short and human**, or absent (§5 Code comments). No verbose AI-style blocks.
- **No hardcoded value where an env var already exists**, and no change unrelated to the ticket —
  both are recurring review questions.
- **No artefacts** — `.playwright-mcp/`, loose `.png`/`.jpeg`, scratch files, preview pages,
  temporary route-allowlist entries, a patched mock.
- **§4 What review here consistently asks for.** Check the diff against each row of the house bar;
  a PR that trips one gets that comment.
- **Docs.** Every PR carries its own docs update where the repo keeps docs (§5 Repo instructions say
  where, and whether any are generated). Work it out from the diff — a staleness checker that dates
  pages against their sources' last commits reports a feature branch as clean and will never tell
  you. Two checks:
  - `grep -rl "<changed path>" <docs dir>` — pages that cite repo-relative paths match a path
    straight from `git diff --name-only`, and a cited directory covers everything beneath it.
  - Files that feed a docs generator (an env example, an API router, a schema): regenerate with the
    command the repo's instructions give, run through §4 Command prefix, and discard a diff that is
    only a date stamp.

  No docs in the repo: the slot is "none", and says so. What a change set breaks is nearly always a
  count: procedures, stacks, env vars, allowlist entries. Prose about a mechanism usually survives,
  so read the claim before assuming it broke. A generated page quotes its source, so a stale comment
  is a source fix, not a page edit. Fill the `docs` slot and **wait** — rewriting a page is the
  user's call. "None" is a real answer.

- **Infra.** "Touches infra" means the paths §4 People "Infra and security owner" lists (typically
  infrastructure-as-code, deploy config and CI workflows). That owner is pinged on every such PR,
  and reviews them for accidental complexity: expect to justify new infrastructure, and prefer fewer
  moving parts — a new table where none is needed gets called overkill. When the slot is not
  "none", draft the ping for the user once the PR is up. Draft only — sending a Slack message as the
  user is `never` in §3 (`slack-send`). Owner `you`: no ping, but the slot still records it. Owner
  `none`: record the slot and say nobody is named to tell.

- **Self-review has run.** `desk-ticket` Stage 4b runs §4 Local review command before the branch
  becomes a PR. Fill the slot from that run's report — the counts and the head SHA it read — or
  state why it did not run. Clean means the report matches §4 Clean review verdict. Do not start the
  body first: a confirmed top-severity finding changes the diff, and every sentence written before
  it is wasted. §4 Local review command `none`: the slot reads "not run — no local review command
  for this repo", and the Testing section carries the checks that did run.

  Two things carry through verbatim. **The SHA**, because a report against an earlier head says
  nothing about what you are about to push. And **what refuted the findings** — with `codex`
  answering (config §4 "Codex answers a real call?") and §3 `codex-review` allowing it, the
  refutation is a real cross-vendor pass; on a run that fell back to a Claude agent the
  `(same-vendor)` tag comes through with it, and dropping it claims cross-vendor verification that
  did not happen.

Whether the block then waits or proceeds depends on config §3 `git-push`: `ask` waits for an
answer; `yes` prints it as a record and pushes. A stray commit stops either way.

## 2. The body

The sections are the ones §5 PR body names, in its order. For the common shape — intro ·
`### Changes` · `### Testing` · optional `### Before / after` — it looks like this:

```markdown
<!-- desk-pr: body -->
<One or two sentences: what was wrong and what this does. Ticket ref in
parentheses at the end when it reads naturally (<TICKET>).>

### Changes
- <what changed, naming the component or module, and why where it isn't obvious>

### Testing
- <checks run: §4 Typecheck, §4 Lint, the specs — plus what actually passed>
- <manual verification, with concrete evidence>

### Not migrated     <- optional: only when equivalent sites were left on the old pattern
- `<path>#<symbol>` — <one line on why it was left>

### Carried review findings     <- optional: only when round 3 of the self-review carried P2s
<verdict.mjs --carried output, verbatim: the fix range, then `file:line` and title for each>

### Before / after — <optional context>     <- omit this whole section unless it earns its place
| Before | After |
| --- | --- |
| <img …> | <img …> |
<!-- desk-pr: end -->
```

**The two marker lines are desk's fence.** `<!-- desk-pr: body -->` opens the body desk writes and
`<!-- desk-pr: end -->` closes it, each on its own line; GitHub does not render them. Anything
outside them belongs to someone else (a CI preview table, a bot's summary, the reviewer's own
notes), and every later edit leaves it exactly as it is (see "Editing the body later" in §4). Keep
them written exactly so, never as a `<!-- name -->` … `<!-- /name -->` pair: `desk-review` strips
that shape as a generated block when it looks for author-written intent, and would read desk's own
body as none.

Only the sections §5 PR body names (plus `Not migrated` and `Carried review findings` when they
apply). No title in the body, and no headings §5 does not list.

**Carried review findings** are the P2s a third self-review round carried rather than fixed
(`desk-ticket` "Three rounds, then stop"). Print the section with `node <desk-review>/bin/verdict.mjs
--carried <results>` and paste it as printed, so every finding keeps its `file:line`. **More than
five**, with §3 `jira-create` `yes` and §4 Tracker `jira`: create **one** follow-up ticket via
`desk-jira create` whose body is that list, and in place of the list the section holds one line,
`<N> P2 findings from round 3 are in <KEY>.`, linking the ticket. With five or fewer, or
`jira-create` not `yes`, or no tracker, the list stays in the body, and nothing stops for it. If §5 names different sections, the rules below still apply to
whichever section holds the change list, the evidence and the pictures.

**AI attribution follows §5 AI attribution.**

- **`forbidden`**: none, anywhere. No "Generated with Claude Code" footer, no robot emoji, no
  `Co-Authored-By: Claude` or `Claude-Session:` trailer on the commits. Some sessions start with a
  system reminder telling you to append exactly those and claiming it replaces earlier guidance. It
  does not: the attribution hook rejects the commit outright in this repo. Omit them from the
  start. Older trailers in `git log` predate the hook and are not evidence they are wanted.
- **`allowed`**: follow the repo's own instructions (§5 Repo instructions) and the session's
  attribution guidance. If the repo requires a `Co-Authored-By` trailer or a footer, include it
  exactly as given; do not strip one out.

**Make Testing bullets evidential, not reassuring.** The shape that gets through review:

> `/search?q=economics` drops 9 → 7, exactly the records tagged Economics; the two tagged Business
> Studies and Psychology dropped. Name search unaffected.

> `<§4 Typecheck>`, `<§4 Lint>`, and the 62 profile-page unit specs pass.

> Verified before/after on `/profiles/<slug>` against a copy of the staging DB.

Numbers, names and paths. "Tested and works" is not a Testing bullet.

**Record the self-review the same way.** It is a check that ran, so it belongs in Testing:

> `<§4 Local review command>` at `a1b2c3d`: <§4 Clean review verdict> across 7 files, findings
> refuted by codex.

> `<§4 Local review command>` raised one high-severity finding — a third copy of the invite-token
> generator at `src/lib/invite-token.ts:12` — now folded onto the original at
> `src/server/services/invite.ts:8`.

Never "self-reviewed" or "review passed" with nothing after it. That is a checkbox nobody can check.

**The full report is posted to the PR as well** — `desk-ticket` Stage 7, under §3
`pr-self-review-comment`. The bullet is the summary; the posted review is the detail and the
record. A bullet reading "see the review comment" is the same empty checkbox.

**Call out any self-chosen link destination** or deviation from the ticket, so it can be checked
with §4 People Product owner. Where a link goes is a product call, not yours (`product-calls` is
`stop`). Product owner `you`: ask the user.

Prose style here is ordinary technical English — em-dashes and longer sentences are fine and
normal in PR bodies. That differs from the register for messages to people in
`desk-review-response/references/voice.md`; don't carry one into the other.

### Say it simply, without saying less

Nearly every PR draft comes back with "less verbose", "simpler language", "make it easier to
read". That feedback is about the **prose**, not the content.

- short sentences, plain words, one idea per bullet
- name what changed, not the journey to finding it
- cut hedging, restatement, and anything the diff already shows

> ✗ In order to address the issue described in the ticket, this change modifies the way in which
> the search query is constructed so that it no longer includes the free-text description field…
>
> ✓ Search matched records on their free-text description, so anything that mentioned the term in
> prose surfaced. Now matches name + tags only.

**But do not lose information.** Compress how it is said, never what is said. Still required:

- every distinct change, and why where it isn't obvious from the diff
- what was verified, with the number, path or name that proves it
- any caveat, knock-on effect, or thing deliberately left out of scope
- a dependency on a PR that hasn't merged

A reviewer should never have to ask "and what about X?" about something you knew and left out. If a
point genuinely doesn't belong in the PR, it goes in the ticket comment or a follow-up ticket (or,
with §4 Tracker `none`, a follow-up issue or the user's notes) — never nowhere. A follow-up ticket
is written in desk-jira's `references/ticket-template.md` layout for its type, through `desk-jira`'s
gate.

## 3. Screenshots — only when a picture shows what words can't

Include the before/after section **if and only if the change alters what someone sees on screen**
(and §5 PR body has room for it). That is the test — not "is this a frontend file".

**Include them for:** layout, spacing, colour, copy, a component appearing or disappearing — and for
result-set changes where the count or ordering *is* the point. A search-relevance change with no
visual redesign still earns the table when it shows `/search?q=economics` dropping 9 → 7.

**Leave the section out entirely for:** server, data-layer, API or schema changes with no rendered
difference · test-only changes · config, env or CI changes · refactors that are visually identical
by design · data work whose deliverable is a script.

When you leave it out, say so in one line — "no screenshots, nothing renders differently" — so it
reads as a decision rather than an omission. **An empty table, or placeholder rows on a PR that has
no images coming, is worse than no section at all.** Reviewers expect before/after on PRs that do
change the rendering — so when it qualifies, it isn't optional.

**Keep the table small.** Match the pairs to the change: a mobile-only fix gets the mobile pair only.
Reviewers cut oversized tables on request ("do we need 24 images?").
Pick the two or three widths that carry the change, say in the line above the table that the other
widths were verified by measurement, and put the numbers in Testing. A ticket asking for "screenshots
at each breakpoint" does not override this. **The one exception is a ticket with a saved canvas**
(below): it shows every breakpoint, collapsed.

### A ticket with a saved canvas: every breakpoint, canvas beside build

When the ticket builds from a Claude Design canvas saved in the repo (`<§2 Design canvases
directory>/<EPIC or KEY>/`, whose `source.json` lists the ticket), the width cap above does not
apply. The canvas is the specification, so the reviewer sees it next to the built page at every
size:

- **Rows**: one per width in §5 Breakpoints (`desk-env list breakpoints`; unset is desk-design's
  default `390` `768` `1024` `1280` `1440`, and `none` leaves only the drawn widths), plus each
  board's own drawn width where it is not a breakpoint. If `source.json` has no `screens` record (a re-save of a new
  version drops it) or `source.screens.breakpoints` differs from the row, run `desk-design render`
  (desk-ticket, "A Claude Design canvas is saved into the repo") before capturing.
- **Canvas cell**: the board's image at that width, `screens/<board>@<width>.png` from
  `source.screens.images` (its `drawn` flag says whether the designer drew that width or the browser
  reflowed the board to it). Copy each into `<§2 Handoff directory>/<TICKET>/` as
  `canvas-<board>-<width>.png` so it uploads with the rest (an autopilot worker has no `cp`: do it
  in the capture script). Names stay to letters, digits and `-`: the upload matches each cell by
  the alt text GitHub writes from the file name.
- **Built cell**: the page at the same width, `built-<board>-<width>.png`, captured as below.
- **Result**: `PASS` with what was compared, `FAIL` with expected against actual (the board's value,
  never the code's), or `UNVERIFIABLE` with why. A comparison that did not run is `UNVERIFIABLE`,
  never `PASS`: no canvas image at that width, no built capture, or the two not actually compared.
  Take the results from the design-build agent's per-width Visual Comparison where one ran, and
  check them against the images rather than copying them.

One collapsed table per board the ticket uses (the README's ticket-to-board table), with the counts
in the summary so a reviewer sees the outcome without opening it:

```markdown
<details>
<summary>Order summary: canvas vs build at 6 widths (5 PASS, 1 FAIL)</summary>

| Width | Canvas | Built | Result |
| --- | --- | --- | --- |
| 390 | _drag canvas-order-summary-390.png_ | _drag built-order-summary-390.png_ | PASS: copy, colours, 16px padding |
| 420 (drawn, not a breakpoint) | _drag canvas-order-summary-420.png_ | _drag built-order-summary-420.png_ | FAIL: total 18px, board 20px |

</details>
```

Leave a blank line after `<summary>` and before `</details>`, or GitHub renders the table as text.
Where the page existed before the ticket, a before/after pair in the short form above still goes
alongside; the canvas table does not replace it. Testing carries the counts per board. A UI PR with
no saved canvas keeps the short form.

**Capturing.** Playwright at the chosen widths, saved to `<§2 Handoff directory>/<TICKET>/`.
Pick the cheapest surface that renders real copy — **read `references/screenshot-surfaces.md`**
before the first capture. It covers local surfaces and §4 Staging (with the token from §4 Staging
bypass token location when staging is protected; §4 Staging `none` means local only). The two traps
that ruin shots most often: a cookie-consent banner (seed its cookie before the first `goto`) and a
"before" that renders missing i18n keys (restore the old component *and* its messages file
together).

If glyphs or emoji render as monochrome tofu in headless Chromium: on WSL (config §2), copy the
Windows emoji font once — `cp /mnt/c/Windows/Fonts/seguiemj.ttf ~/.local/share/fonts/ && fc-cache -f`;
elsewhere install a colour emoji font such as Noto Color Emoji.

Then delete the Playwright script and artefacts from the repo and confirm `git status` is clean.

### The image table

GitHub has no API for PR-body image attachments, and on a private repo `raw.githubusercontent` links
will not render for reviewers. The assets have to be minted through the web UI — by the automated
upload below, or by hand.

**Always write the body with placeholder cells first**, one row per image pair. The upload script
swaps exactly these cells, and they are also the manual fallback:

```markdown
| Before | After |
| --- | --- |
| _drag before-desktop.png_ | _drag after-desktop.png_ |
| _drag before-mobile.png_ | _drag after-mobile.png_ |
```

**Name the actual files**, exactly as they sit in `<§2 Handoff directory>/<TICKET>/`. A cell that
names the wrong file puts the wrong image in the wrong row — and a 1366 shot in the 1440 row is a
review comment. For the script, the cell must be `_drag <exact filename>_` or it is not swapped.

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

The upload drives a browser profile signed in to GitHub **as the user** (config §2 "Signed-in browser
profile") against a real PR.

| Config §3 `pr-images` | What you do |
|---|---|
| `yes` | Show the block below as a record, run the upload, show the result. |
| `ask` | Show the block, **stop and wait**, every run. Silence is not approval. |
| `no` or `TODO` | Placeholder table only; hand it over for dragging. Don't offer the upload. |

```
IMAGE UPLOAD
PR         : #<n> <title>
images     : <n> files from <§2 Handoff directory>/<TICKET>/  (<list>)
method     : signed-in browser (<§1 GitHub handle>) uploads to the new-comment box, never submitted;
             placeholders swapped in the body with gh pr edit --body-file
```

`yes` covers this upload on the user's own PRs only. It is not a waiver of any other gate, and it
never covers speaking as the user.

**Run the script** if it is installed:

```bash
node ~/.claude/desk/bin/upload-images.mjs <pr-number> <§2 Handoff directory>/<TICKET>/
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
| 6 | setup: Playwright not installed, or no saved GitHub login or it has expired (it names `github-signin.mjs`) |

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

### Before every push: the pre-push checks

Where `desk-env cmds pre-push-checks` prints items (the row is set and not `none`), run the repo's
committed script on HEAD **yourself before every push of the branch**: the first push, and every
fix-up after a review or a rebase.

```bash
bash scripts/desk/pre-push.sh --head
```

Do not rely on the git hook. It runs only in a clone whose `core.hooksPath` is `.githooks`, and
nothing checks that a worktree, a fresh clone or a worker's checkout has it. When every check
passes, the script records HEAD, so the hook (where it is active) does not run the checks a second
time on the push that follows. A new commit runs them again.

- **Non-zero exit: do not push.** The output names the failing command and its output, which is the
  failure CI would report minutes later. Fix it, commit, and run the script again. Never
  `git push --no-verify` to get past it.
- **An item skipped on the lock** (the box-wide test lock stayed busy) is not a failure: CI runs it.
  Name it in the `pre-push` slot.
- **The row is set but `scripts/desk/pre-push.sh` is not in the tree**: the templates were never
  committed here. Say so, push as before, and offer `/desk-setup` to add them.
- **Unset or `TODO`**: push as before, and say once that `/desk-setup` can set it. **`none`**: push.

Fill the `pre-push` slot of the §1 block from the run.

### Before `gh pr create` or `gh pr edit`: the PR-description checks

Where `desk-env cmds pr-description-checks` prints items, CI checks the PR's description, and a
body that fails is a red check on the first run. Write the body to its file first, then run each
item in its directory with the file's absolute path appended:

```bash
<cmd> <absolute path to the body file>                                          # an item at the root
~/.claude/desk/bin/with-lock.sh nolock --cwd <DIR> -- <cmd> <absolute path>    # an item with a directory
```

Run it on **every** body you are about to hand to `gh pr create` or `gh pr edit --body-file`, not
only the first one.

- **It passes**: create or edit.
- **It fails on something the body owns** (a missing section, a heading, the ticket reference, an
  unticked box the template asks for): fix the body, re-run, then create or edit.
- **A fix would need content you do not have** (a value you would be inventing, a sign-off someone
  else gives) **or the failure is not about the body**: stop and report the output. Do not open or
  edit the PR with a body you know fails.

The image upload script's own edit only swaps `_drag <file>_` cells for images in a body you already
checked, so it is not run through the checks again.

### Open it

```bash
gh pr create --repo <§0 GitHub repo> --draft --base <default> --head <your branch> \
  --body-file <path> --title "<title in the §5 PR title format>"
```

Gated on config §3 `pr-open`. Always pass `--repo`, `--head` and `--title` explicitly, and keep
`--repo <§0 GitHub repo> --draft` first, in that order: an autopilot worker's allow rule matches only
a command beginning `gh pr create --draft` or `gh pr create --repo <§0 GitHub repo> --draft`, and the
same form keeps interactive and worker PRs identical. `--repo` is
what keeps the PR on this repo when `origin` is a fork (without it `gh` may offer, or pick, the
fork), and `--head` is the ticket's recorded branch, the one the merge driver will look the PR up
by.

**Draft first**, unless §5 PR lifecycle says this repo doesn't use drafts. The draft gives the
images somewhere to land. Then follow §5 PR lifecycle; the usual order is: upload the images, post
the Stage 4b self-review (`desk-ticket` Stage 7), and — if §3 `pr-ready`, `pr-auto-merge` and
`pr-merge-green` all allow, and §4 Repo merge settings allow auto-merge — `gh pr ready <n> &&
gh pr merge <n> --auto --<§4 Merge method> --match-head-commit <headRefOid>`. **Arm auto-merge only
when GitHub's gate and ours coincide**: every check that runs on this repo's PRs is either in §4
Required checks (which GitHub enforces) or in §4 Advisory checks. GitHub's auto-merge waits only for
the checks branch protection requires, so where another check runs (a path-filtered API suite, say)
it would merge past that check failing. Otherwise do not arm it: undraft, and merge when the head is
green by the definition below. Merging needs the head
**green** as the config defines it (desk-config "Green": every §4 Required checks entry completed
with success, skipped not counting; nothing else failed, errored, timed out or still running unless
§4 Advisory checks names it; at least one success), and is always pinned to that head with
`--match-head-commit`. A PR touching a glob in §4 Merge holds is never armed or merged by a skill:
report it with the hold's reason and the user merges. Never `--admin`, never past a failing check
(`merge-bypass` is `never`). A draft cannot merge, so a PR left drafted is a merge silently deferred; if a row says
`no`, say plainly it waits on the user. `desk-ticket`'s "Merging" section owns shepherding,
including disarming auto-merge when review feedback lands under §3 `merge-feedback-first`. If `gh`
fails, fall back to handing over the raw markdown to paste.

**The title follows §5 PR title exactly** — the format (e.g. conventional commits
`type(scope): <TICKET> description`), where the key sits, and whether CI checks it. When §4 Merge
method is `squash` and the repo squash-titles from the PR title, this one string is what reaches the
default branch, and it is often the only thing a Jira integration parses for a key.

- Match the key to §4 Ticket key pattern **exactly, case included**: a lowercased key links to
  nothing. Put it where §5 PR title puts it; a key in the wrong position fails a title check.
- If §5 PR title uses conventional commits, the type comes from the standard set
  (`feat|fix|chore|ci|docs|test|refactor|perf|build|style|revert`), a `!` before the colon marks a
  breaking change, and a scope is lowercase `[a-z0-9./_-]` — **an uppercase or spaced scope
  commonly fails and reports itself as a *type* error**, so check the scope's case before you doubt
  the type. Take scopes from the repo's instructions or recent merged titles; omit one rather than
  invent it for a change spanning several.
- Genuinely ticketless work, in a repo with a tracker, takes whatever §5 PR title says waives the
  key (a label, a marker). That is the user's call — ask. With §4 Tracker `none`, titles carry no key.
- §5 Repo instructions win on anything the repo's own files say about titles.

**A CI title check that runs on `pull_request` with the default event types does not re-run on
rename**: `edited` is not one of them. Renaming a PR does not re-run the check, and re-running the
failed job replays the *old* payload — only a push clears a bad title. Get it right at
`gh pr create`.

**The branch feeds the title.** Branches follow §5 Branch names (e.g. `<type>/<TICKET>-short-slug`,
with the type mapped from the issue type as §5 gives it). Keep the key's case as §4 Ticket key
pattern has it: commit hooks and GitHub's title pre-fill take it from the branch. A branch with no
key (`worktree-*`, `agent-*`) gives both nothing to work with.

**When one ticket ships as more than one PR**, number the parts after the key, unless §5 PR title
says otherwise. **Digits, never letters** — `(1/2)`, not `(A/B)`:

```
feat(auth): ABC-512 (1/2) add the parent-invite backend
feat(auth): ABC-512 (2/2) add the sign-up UI for the parent invite
```

The first number is this part, the second the total — a three-part ticket runs `(1/3)`, `(2/3)`,
`(3/3)`. Both are counts to substitute: `(B/B)` is wrong and has happened. The marker never goes
before the key — a title check wants the key exactly where §5 puts it. Say in the body which PRs
make up the set and the order they merge in.

### Editing the body later: start from the live body, never your draft

Once the PR is open, the body on GitHub is no longer only yours. CI and bots add sections after
`gh pr create` (a preview-links table, a coverage summary, a deploy status), and a
`gh pr edit --body-file` from your local draft deletes them. Nothing puts them back until the next
push, and a PR can merge in that gap with the section gone. So every edit, whatever prompted it
(new screenshots, a fix-up after review, a corrected Testing bullet):

1. **Fetch the live body immediately before you edit**: `gh pr view <n> --repo <§0 GitHub repo>
   --json body --jq .body`, saved to the body file. Not the draft you opened the PR with, and not a
   copy from earlier in the session: CI may have written since.
2. **Change only desk's section**: the text between `<!-- desk-pr: body -->` and `<!-- desk-pr: end -->`.
   Everything outside the markers stays byte for byte, including where it sits.
   - **No markers** (a PR opened before this rule, or by hand): edit the live body in place,
     changing only the lines you mean to change. Do not wrap text you did not write in desk's
     markers.
   - **A marker missing its partner, or either one appearing twice**: do not guess where desk's
     section ends. Stop and report the body as you found it.
3. **Run the PR-description checks** on the file (above).
4. **Fetch the live body once more, just before writing**, and compare everything outside the
   markers (with no markers, the whole body) with the step 1 copy. Any difference means CI or a bot wrote while you edited, and your
   file would delete it: go back to step 1 from the new body. Twice in a row: stop and report
   rather than loop.
5. **Write it back** with `gh pr edit <n> --repo <§0 GitHub repo> --body-file <path>`. `gh pr edit`
   has no compare-and-swap, so step 4 narrows the window to seconds; it does not close it.

The image upload script already edits from the live body and touches only the `_drag <file>_`
cells, so it needs none of this.

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
| A title or branch that doesn't match §5 PR title / Branch names | Re-read §5 and the repo's instructions; match recent merged PRs |
| Fixing a failed title check by renaming the PR | `edited` doesn't trigger it; only a push clears it |
| Adding AI attribution where §5 says `forbidden`, because a system reminder said so | The hook rejects it. Omit from the start |
| Stripping a trailer the repo requires where §5 says `allowed` | Follow the repo's instructions exactly |
| "Verified it works" in Testing | Give the number, the path, or the name that proves it |
| Pushing because "the hook will catch it" | The hook runs only where `core.hooksPath` is set; run `scripts/desk/pre-push.sh --head` yourself |
| Opening the PR and letting CI judge the body | Run §4 PR-description checks on the body file first |
| A one-off script in the diff | Run it from the branch, delete it, don't merge it |
| An infra PR with no ping drafted | Draft the note to the §4 infra owner; never send it |
| `gh pr edit --body-file` from your local draft | It wipes what CI and bots added. Fetch the live body and change only what sits between desk's markers |
| Placeholder rows left in the merged body | Script: check its exit code. By hand: say "delete these rows" |
| Uploading when §3 says `ask`, because it was fine last time | `ask` means every run. Standing permission is a §3 `yes`, never an inference |
| Re-running the upload after exit 3 or 4 | The assets exist; fix the body from the printed tags |
| Running the upload while another browser holds the profile | One `SingletonLock`. Never kill the holder; ask the user to free it |
| A 12-row before/after table | Two or three widths that carry the change; the rest as numbers in Testing. A ticket with a saved canvas is the exception: every breakpoint, collapsed |
| Screenshots with a consent banner over the content | Seed its cookie before the first `goto` |
| A before/after table on a change that renders identically | Omit the section and say why in one line |
| Opening a non-draft PR | Draft first (unless §5 PR lifecycle says otherwise); images and self-review land before it goes ready |
| Merging with `--squash` because it's the usual | `--<§4 Merge method> --match-head-commit <sha>`, and only once that head is green (desk-config "Green") and no §4 Merge holds entry applies |
| Carrying the messages register into a PR body | Different register; normal prose is right here |
| Shortening a PR by dropping a caveat or a change | Simplify the wording, not the content |
| "Self-reviewed, all clean" in Testing | Give the counts and the SHA |
| "refuted by codex" on a run that fell back to a Claude agent | Tag that run `(same-vendor)` |
