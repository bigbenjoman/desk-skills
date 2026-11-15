# desk-pr: screenshots, the image table and the upload

Read before deciding whether the PR gets screenshots, and then before capturing them, building the
image table and uploading the images. The step table in `../SKILL.md` names this file for those
steps. The config, the diff hygiene block (§1) and the pre-push checks are in `../SKILL.md`, already
loaded; the rest of the body is in `the-body.md`, beside this file. This file hands on to two more
at the point each is needed: `screenshot-surfaces.md` before the first capture, and
`image-upload.md` for an upload without the script.

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
  (desk-ticket `design-canvas.md`, "A Claude Design canvas is saved into the repo") before capturing.
- **Canvas cell**: the board's image at that width, `screens/<board>@<width>.png` from
  `source.screens.images` (its `drawn` flag says whether the designer drew that width or the browser
  reflowed the board to it). Copy each into `<dir>/captures/` as `canvas-<board>-<width>.png`, where
  `<dir>` is `<§2 Handoff directory>/<TICKET>/`, or an autopilot worker's screenshot directory (it
  has no `cp`: do it in the capture script). Names stay to letters, digits and `-`: the stitched
  image is named after the board, and the upload matches each cell by the alt text GitHub writes
  from the file name.
- **Built cell**: the page at the same width, `built-<board>-<width>.png` in the same `captures/`,
  captured as below. Where §4 Storybook (`desk-env cmds storybook-cmd`) is set, `desk-design
  compare --out <dir>/captures` writes both cells for every board a story matches (desk-ticket
  `design-canvas.md`, "Comparing the build with each board"); a board it lists as `not compared`
  gets one line under its table naming it and why (no story matches it), not an `UNVERIFIABLE` row
  per width.
- **Before cell**, where the page existed before the ticket: `before-<board>-<width>.png` in the
  same `captures/`, the page on `<default>` at that width. It is the stitched image's Before column,
  so no separate before/after table goes alongside.
- **Theme**: desk-design has no themes, so a canvas draws a board's dark theme as a board of its
  own, named after the light one with `dark` last ("Order summary dark"). Its captures then read
  `canvas-order-summary-dark-390.png` and `built-order-summary-dark-390.png`, as `desk-design
  compare` names them, and the stitch reads that `-dark` as the theme of `order-summary`; a capture
  script may instead end the name with it (`canvas-order-summary-390-dark.png`). A board whose name
  does not end `light` or `dark` is light, so a dark board named any other way stitches as a board
  of its own and gets its own section.
- **Result**: `PASS`, `FAIL` with expected against actual (the board's value, never the code's), or
  `UNVERIFIABLE` with why, in a few words; what a `PASS` compared is said once, in the line above
  the board's table. A comparison that did not run is `UNVERIFIABLE`,
  never `PASS`: no canvas image at that width, no built capture, or the two not actually compared.
  Take the results from the design-build agent's per-width Visual Comparison where one ran, and
  check them against the images rather than copying them.

**Stitch each board into one image per theme** once every capture is in, so the PR uploads one
image per board and theme rather than one per capture (11 boards in two themes: 22 uploads, not
hundreds):

```bash
~/.claude/desk/bin/with-lock.sh browser node ~/.claude/desk/bin/stitch-boards.mjs <dir>/captures --out <dir>
```

Each `<board>-<theme>.png` has one row per width, with the canvas, before and after captures side
by side and the width and theme written on it; a capture that is missing reads "no capture". An
image that would reach 10 MB is split by width into `<board>-<theme>-<first width>-<last width>.png`
(one width still over it, into `<board>-<theme>-<width>-<role>.png`). A split is a board captured
too large: capture it smaller (the viewport rather than the full page, or a lower device scale)
and stitch again, so the body names one image per board and theme. Only a board still split after
that names each part its `wrote:` lines print, and its summary says why. Exit 2 is a usage error, no captures, or two captures for one cell; 5 is
a single capture over the limit on its own (`over:`), which GitHub refuses: capture it smaller
rather than ship it; 6 is desk's Playwright missing. The upload takes only the files the
body's `_drag <file>_` cells name, so the raw captures stay in `captures/` and only the stitched
images reach the PR. **Open
each stitched image at full size before the body names it**: the 390 row included, every label
readable.

One collapsed section per board the ticket uses (the README's ticket-to-board table): its stitched
images, one per theme, then its results as a text table, with the counts in the summary so a
reviewer sees the outcome without opening it. No cell names a per-width capture: every breakpoint
reaches the PR inside its board's stitched image.

```markdown
<details>
<summary>Order summary: canvas, before and built at 6 widths (11 PASS, 1 FAIL)</summary>

_drag order-summary-light.png_

_drag order-summary-dark.png_

PASS compares copy, colours and padding with the board.

| Width | Light | Dark |
| --- | --- | --- |
| 390 | PASS | PASS |
| 420 (drawn) | FAIL: total 18px, board 20px | PASS |

</details>
```

Leave a blank line after `<summary>`, between the images, and before `</details>`, or GitHub runs
the images together and renders the table as text. A board drawn in one theme has one image and
a single `Result` column. Consecutive widths with the same results share one row
(`| 768–1440 | PASS | PASS |`). Testing carries the totals across the boards, not each board's
counts again. A UI PR with no saved canvas keeps the short form.

**Keep the description under 10,000 characters.** Each uploaded image swaps its `_drag` cell for an
`<img>` tag of about 150 characters, so 22 images add about 3,300. After the upload, read it with
`gh pr view <n> --json body --jq '.body | length'`; over the budget, shorten the `FAIL` notes, the
summaries and the Accepted differences, never a board's images or a row's result.

Below the tables, an **Accepted differences** list names every difference you shipped on purpose:
each `FAIL` left in, and anything the build does differently from a board, with the board, the
width and why, or `none`. A lane D ticket built by an autopilot worker was not agreed before it was
built, so this list and the tables are where the reviewer agrees it.

**Capturing.** Playwright at the chosen widths, saved to `<§2 Handoff directory>/<TICKET>/`.
Pick the cheapest surface that renders real copy — **read `references/screenshot-surfaces.md`**
before the first capture. It covers local surfaces and §4 Staging (`desk-env list staging`; with the token from §4 Staging
bypass token location, `desk-env get staging-bypass`, when staging is protected; §4 Staging `none` means local only). The two traps
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

It uploads only the files the body's `_drag <file>_` cells name, found in the directory or a folder
under it, 15 to a batch, and fills each batch's cells with `![alt](url)` as it lands. Every link goes
in `<directory>.tags.json` with its image's sha256, so a rerun uploads only what is left, and an image
already uploaded is never uploaded again.

| Exit | Meaning |
|---|---|
| 0 | every placeholder replaced, or the body had none left, so nothing was uploaded |
| 1 | bad arguments, missing dir or no images, an unreadable tags file, or an unexpected crash |
| 2 | shared browser profile in use; retry later |
| 4 | uploaded, but placeholders still left (a file no folder holds is named) |
| 5 | not permitted (§3 `pr-images` not `yes`) |
| 6 | setup: Playwright not installed, or no saved GitHub login or it has expired (it names `github-signin.mjs`) |
| 7 | throttled: a batch stalled, which is GitHub's rate limit, so it stopped without retrying; it refuses to run again before the time it prints (15 minutes, doubling with each stall in a row) |

On 4 or 7 just run it again later: what was uploaded is in the tags file and its cells are filled.
Never retry a 7 sooner than the time it printed: retrying into the rate limit risks GitHub blocking
the account. One session at a time: a single profile, one `SingletonLock`.

**Without the script, or when it fails in a way you have to debug**, read
`references/image-upload.md` — the manual steps and every GitHub quirk that has cost a failed run.
Whichever route, afterwards: verify placement (select images by `alt`, read `naturalWidth`), confirm
no `_drag ` cells survive, delete any `.playwright-mcp/` directory, and confirm `git status`.

The permission classifier may refuse this independently of config. That refusal is never a thing
to work around — say so and let the user decide whether to grant the Bash permission. If the
profile is signed out or signed in as someone else, stop and use the placeholder table; never
attempt a login.
