# Uploading PR images by hand-driven browser

Read this when `~/.claude/desk/bin/upload-images.mjs` is not installed, or when it fails and you
have to work out why. Every rule below cost at least one failed run. The permission gate in
`SKILL.md` §3 applies unchanged, and each re-run is a fresh use of it — get the wait right first time.

## Setup

Do not use the Playwright MCP for this. Drive the signed-in profile directly:

```js
import { chromium } from '<primary repo root>/node_modules/playwright/index.mjs';
const PROFILE = '<config §2 "Signed-in browser profile">';
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 1200 } });
```

Import `playwright` by **absolute path**; a script in a scratch directory cannot resolve it by bare
name. If the profile needs a specific Chromium build, pass `executablePath` too — find it on the
machine, never copy one from someone else's notes.

## Steps

0. **Check nothing else holds the profile.** A live Chromium on it owns a `SingletonLock`, so a
   second launch dies with "Failed to create a ProcessSingleton" — or has its page closed under it
   mid-upload.

   ```bash
   pgrep -af "[u]ser-data-dir=<profile dir>"
   ```

   The bracket stops `pgrep` matching its own command line. The usual holder is the Playwright MCP
   browser used for the screenshots — `browser_close` closes the tab, not the process. **Do not kill
   it**; it may belong to another session mid-capture. Say the profile is busy and let the user free
   it. Copying the profile is not a workaround: it is a directory of live session cookies, and the
   classifier refuses it, correctly.
1. **Check the session.** `meta[name="user-login"]` must match config §1 GitHub handle. Signed out, or
   someone else: stop, use the placeholder table, never attempt a login.
2. **Upload into the new-comment box, never submit it.** Assets persist either way, so the
   description is never left half-edited. Open the PR with `waitUntil: 'domcontentloaded'` —
   **never `networkidle`**, GitHub long-polls and the goto times out.
3. **Focus the form first.** `textarea#new_comment_field` → `scrollIntoViewIfNeeded()` → `click()`.
   Without it the `<file-attachment>` element never fires, and there is no POST to
   `/upload/policies/assets` at all.
4. **The file input is hidden.** `form:has(textarea#new_comment_field) input[type=file]`, waited with
   `{ state: 'attached' }` — the default `visible` times out with the element right there.
   It is `multiple`; setting all files in one `setInputFiles` works **provided the wait in
   step 5 is per file**. `input.files.length` reads 0 afterwards because GitHub consumes it.
5. **Wait per file, on that file's own finished tag.** GitHub inserts an HTML `<img>` into the
   textarea's value, not `![alt](url)` markdown, and the **alt drops the extension**
   (`before-mobile.png` → `alt="before-mobile"`). It also inserts `Uploading <file>…` the instant a
   file is set, so a wait on "filename present and some `user-attachments` URL present" passes
   immediately from the previous file's URL — such a loop can print six successes while GitHub
   keeps one asset.

   ```js
   const base = file.replace(/\.[^.]+$/, '');
   await page.waitForFunction(({ base, file }) => {
     const t = document.querySelector('textarea#new_comment_field')?.value ?? '';
     return new RegExp(`<img[^>]*alt="${base}"[^>]*src="https://github.com/user-attachments/assets/`).test(t)
       && !t.includes(`Uploading ${file}`);
   }, { base, file }, { timeout: 180000 });
   ```

6. **Capture the tags before clearing the textarea**, then clear it. There is no API to list
   `user-attachments` assets afterwards; the only recovery is re-uploading. Map tags to cells **by
   alt**, never by upload order.
7. **Set the body with `gh pr edit <n> --body-file`**, not the browser editor — the file on disk is
   your undo. Write that file from the **live** body (`gh pr view <n> --json body --jq .body`)
   fetched just before the edit, never from your local draft, so whatever CI or a bot added since
   the PR opened survives; swap only the `_drag <file>_` cells (SKILL.md §4, "Editing the body
   later"). `<img alt="…" src="…" width="400">` in the cells keeps a multi-row table readable.
8. **Verify.** Reload with `domcontentloaded`, `window.scrollTo(0, 400)`, wait a few seconds so the
   description images load, then select images **by alt** and read `naturalWidth`. On a private repo
   the rendered src is rewritten to `private-user-images.githubusercontent.com`, so
   `img[src*="user-attachments"]` finds nothing and looks like a failure. A shot captured at viewport
   783 reports 783 — or **double with `deviceScaleFactor: 2`**, which is the proof, not a mismatch.
   `naturalWidth` also catches a harness that rendered at the wrong size (a 262px
   "before"). Confirm no `_drag ` cells remain and the PR is in the state you left it.
9. Delete `.playwright-mcp/` — it is not gitignored. Confirm `git status`.

## When it appears to hang

Log requests to `/upload/` and dump the textarea value before suspecting permissions or the session.

| Symptom | Cause |
|---|---|
| No POST to `/upload/policies/assets` | The form was never focused (step 3) |
| 201 from the upload, wait still times out | The wait condition is wrong: markdown regex, or alt with the extension (step 5) |
| "We don't support that file type" / "Attaching documents requires write permission" in the DOM | Pre-rendered error templates, always present. Not a real failure |
