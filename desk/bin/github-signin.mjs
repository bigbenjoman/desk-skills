// Sign the configured browser profile (config §2 "Signed-in browser profile") in to GitHub, for
// upload-images.mjs. Run it from the repo, in a terminal on the machine with a screen:
//
//   node ~/.claude/desk/bin/github-signin.mjs
//
// It opens a visible Chromium at github.com/login and waits (up to 20 minutes) for the page to
// show a signed-in user, then saves GitHub's login cookies to <profile>.github-session.json
// (owner-only) and closes the browser itself.
//
// Why the file: GitHub sets its login as session cookies, and Chromium drops session cookies on
// exit, so the profile alone reads as signed out on the uploader's next launch. Cookies added
// with addCookies are not persisted by the profile either. The file is as sensitive as the
// profile: it is a live GitHub session until GitHub expires it. Delete it to sign out.
//
// Exit codes: 0 signed in and saved · 1 no sign-in within the wait · 6 setup or config
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { browserProfile, DeskConfigError } from './desk-env.mjs';
import { findPlaywright, sessionFile } from './find-playwright.mjs';

let PROFILE;
try {
  PROFILE = browserProfile();
} catch (e) {
  if (!(e instanceof DeskConfigError)) throw e;
  console.error(e.message);
  process.exit(6);
}
if (!existsSync(PROFILE)) mkdirSync(PROFILE, { recursive: true });

const { entry, tried } = findPlaywright();
if (!entry) {
  console.error(`[signin] playwright not found (tried: ${tried.join(', ')}). Point DESK_PLAYWRIGHT at playwright/index.mjs.`);
  process.exit(6);
}
const { chromium } = await import(pathToFileURL(entry).href);

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

const cookies = (await ctx.cookies()).filter((c) => /(^|\.)github\.com$/.test(c.domain.replace(/^\./, '')));
const file = sessionFile(PROFILE);
writeFileSync(file, JSON.stringify({ user, savedAt: new Date().toISOString(), cookies }, null, 1), { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`[signin] signed in as ${user}; saved ${cookies.length} GitHub cookie(s) to ${file}. Closing the window.`);
await page.waitForTimeout(1500);
await ctx.close();
