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
