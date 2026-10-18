// Sign this machine in to GitHub once, for upload-images.mjs and Claude's Playwright MCP in every
// repo and worktree. Run it in a terminal on the machine with a screen, from anywhere:
//
//   node ~/.claude/desk/bin/github-signin.mjs
//
// It opens a visible Chromium at github.com/login on the browser profile (the machine one,
// ~/.cache/ms-playwright-mcp/desk-profile, unless config §2 "Signed-in browser profile" overrides
// it for this repo) and waits (up to 20 minutes) for the page to show a signed-in user, then saves
// GitHub's login cookies as a storage-state file, <profile>.github-session.json (owner-only), and
// closes the browser itself. Run it again when GitHub expires the session.
//
// Why the file: GitHub sets its login as session cookies, and Chromium drops session cookies on
// exit, so the profile alone reads as signed out on the uploader's next launch. Cookies added
// with addCookies are not persisted by the profile either. The MCP loads the same file into each
// session's isolated browser (install.sh registers it with --storage-state), so no session needs
// the profile, or its lock. The file is a live GitHub session until GitHub expires it: delete it
// to sign out.
//
// Exit codes: 0 signed in and saved · 1 no sign-in within the wait · 6 setup or config
import { existsSync, mkdirSync } from 'node:fs';
import { browserProfile, DeskConfigError } from './desk-env.mjs';
import { findPlaywright, importPlaywright, githubCookies, saveSession } from './find-playwright.mjs';

let PROFILE;
try {
  PROFILE = browserProfile();
} catch (e) {
  if (!(e instanceof DeskConfigError)) throw e;
  console.error(e.message);
  process.exit(6);
}
if (!existsSync(PROFILE)) mkdirSync(PROFILE, { recursive: true });

const playwright = findPlaywright();
if (!playwright.entry) {
  console.error(`[signin] playwright not found (tried: ${playwright.tried.join(', ')}). Re-run desk-skills' ./install.sh ` +
    '(or /desk-update), which installs desk\'s own, or point DESK_PLAYWRIGHT at an installed playwright/index.mjs.');
  process.exit(6);
}
const { chromium } = await importPlaywright(playwright);

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: null });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://github.com/login');
console.log(`[signin] sign in to GitHub in the window that opened (profile ${PROFILE}).`);

let user = '';
for (let i = 0; i < 600 && !user; i++) {
  await page.waitForTimeout(2000);
  user = await page.evaluate(() => document.querySelector('meta[name="user-login"]')?.content || '').catch(() => '');
}
if (!user) {
  console.error('[signin] no sign-in within 20 minutes; nothing saved.');
  await ctx.close();
  process.exit(1);
}

const cookies = await githubCookies(ctx);
const file = saveSession(PROFILE, user, cookies);
console.log(`[signin] signed in as ${user}; saved ${cookies.length} GitHub cookie(s) to ${file}. Closing the window.`);
console.log('[signin] Claude\'s browser loads it when it starts: restart any session whose browser is already open.');
await page.waitForTimeout(1500);
await ctx.close();
