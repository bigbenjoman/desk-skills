#!/usr/bin/env node
// Upload a ticket's screenshots to its PR and swap them into the body.
//
// Used by desk-autopilot's pass.mjs (automatically, when a worker prints AUTOPILOT_IMAGES:) and
// runnable by hand. Runs from the ORCHESTRATOR, never a worker: there is one shared signed-in
// Chromium profile with one OS-level SingletonLock, so this has to be serialised and the
// orchestrator is the only single-threaded thing here.
//
// Gated on config §3 pr-images: `yes` runs; anything
// else runs only with DESK_UPLOAD_APPROVED=1, which the caller sets after asking the user for
// THIS upload. The browser acts as the user on a real site.
//
// Everything below is load-bearing and each cost a failed run once:
//   - GitHub inserts an <img ...> tag into the textarea's VALUE, not a DOM node, and not
//     markdown. Waiting for an <img> element times out while the upload succeeded.
//   - The alt it writes DROPS the extension: before-desktop.png -> alt="before-desktop".
//   - The file input is hidden (state:'attached', not 'visible') and IS multiple.
//   - The form must be focused first or no POST to /upload/policies/assets ever fires.
//   - Capture the URLs BEFORE clearing the box; there is no API to list these assets after.
//   - Never delete a SingletonLock in the profile: it is very likely a peer's upload in flight.
//
// Which files, the batches, the tags file (<image-dir>.tags.json) and the stall stop are
// upload-batches.mjs's.
//
// Exit codes (pass.mjs and desk-pr read these):
//   0 every placeholder replaced, or none left   3 not used (it was: uploaded, but no placeholder matched)
//   1 bad arguments, no such dir, no images     4 uploaded, but placeholder(s) are still left in the body (a
//                                                 file no cell's name finds is named)
//   2 the shared profile is in use (retry)      5 not permitted: config §3 pr-images is not yes and no DESK_UPLOAD_APPROVED
//   6 setup or config: playwright not installed, or no saved GitHub login, or it has expired (run
//     github-signin.mjs: GitHub's login is a session cookie the profile drops on exit, so it is kept
//     in <profile>.github-session.json instead, which Claude's Playwright MCP loads too)
//   7 throttled: a batch stalled, which is GitHub's rate limit, so the run stopped there; or an earlier
//     stall's retry_after has not passed, so nothing was uploaded. The links uploaded so far are in the
//     tags file and their cells are filled, and the line printed says when it may run again.
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runUpload, shotIndex, UploadStop } from './upload-batches.mjs';
import { permission, permissionKey, browserProfile, ghRepo, DeskConfigError, psRows } from './desk-env.mjs';
import { findPlaywright, importPlaywright, sessionFile, githubCookies, saveSession, loadSessionCookies, loginState } from './find-playwright.mjs';

const [pr, dir] = process.argv.slice(2);
if (!pr || !dir) { console.error('usage: upload-images.mjs <pr-number> <image-dir>'); process.exit(1); }
if (!existsSync(dir)) { console.error(`no such directory: ${dir}`); process.exit(1); }

const perm = permission('pr-images');
if (perm !== 'yes' && !process.env.DESK_UPLOAD_APPROVED) {
  console.error(`[upload] config §3 ${permissionKey('pr-images')} is ${perm} — ` +
    'ask the user, then re-run with DESK_UPLOAD_APPROVED=1. Not uploading.');
  process.exit(5);
}

// The machine's profile, or this repo's §2 override. The login is the file github-signin.mjs saved
// beside it, so a missing or expired one is said here, before a browser opens on a signed-out page.
let PROFILE;
try {
  PROFILE = browserProfile();
} catch (e) {
  if (!(e instanceof DeskConfigError)) throw e;
  console.error(e.message);
  process.exit(6);
}
const SIGNIN = 'node ~/.claude/desk/bin/github-signin.mjs  (opens a window; run it where there is a screen)';
const login = loginState(PROFILE);
if (login.status !== 'ok') {
  console.error(login.status === 'expired'
    ? `[upload] the saved GitHub login${login.user ? ` (${login.user})` : ''} expired on ${login.expiredAt}: ${login.file}.`
    : `[upload] no saved GitHub login: ${login.file}.`);
  console.error(`[upload] sign in with: ${SIGNIN}`);
  process.exit(6);
}
if (!existsSync(PROFILE)) mkdirSync(PROFILE, { recursive: true });

const REPO = ghRepo();
const playwright = findPlaywright();
if (!playwright.entry) {
  console.error(`[upload] playwright not found (tried: ${playwright.tried.join(', ')}). Re-run desk-skills' ./install.sh ` +
    '(or /desk-update), which installs desk\'s own, or point DESK_PLAYWRIGHT at an installed playwright/index.mjs.');
  process.exit(6);
}
const { chromium } = await importPlaywright(playwright);

if (!shotIndex(dir).size) { console.error(`no images in ${dir} or a folder under it`); process.exit(1); }

// Refuse to run two at once: the profile has a single lock and a collision either kills
// the browser or closes the page mid-upload. `ps` rather than `pgrep -a` (procps-only).
let procs;
try { procs = psRows('pid=,args='); } catch (e) {
  console.error(`[upload] ${e.message}, so whether the shared profile is in use is unknown — refusing`);
  process.exit(2);
}
const holders = procs.map((p) => `${p.pid} ${p.args}`)
  .filter((l) => l.includes(`user-data-dir=${PROFILE}`) && !l.includes('upload-images.mjs'))
  .join('\n').trim();
if (holders) { console.error(`[upload] the shared profile is in use — refusing:\n${holders}`); process.exit(2); }

// The comment box, opened only once there is something to upload.
let ctx = null;
let user = '';
async function openPage() {
  ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 1200 } });
  // The profile drops GitHub's session cookies on exit; github-signin.mjs saved them alongside it.
  const saved = sessionFile(PROFILE);
  await ctx.addCookies(loadSessionCookies(PROFILE));

  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(`https://github.com/${REPO}/pull/${pr}`, { waitUntil: 'domcontentloaded' });

  // Signed out, a private repo's PR is a 404 with no comment box: say so rather than time out on it.
  user = await page.evaluate(() => document.querySelector('meta[name="user-login"]')?.content || '');
  if (!user) throw new UploadStop(6, `the saved GitHub login has expired: GitHub no longer accepts ${saved}.\n[upload] sign in with: ${SIGNIN}`);

  const ta = page.locator('textarea#new_comment_field');
  await ta.waitFor({ state: 'attached', timeout: 30000 });
  await ta.scrollIntoViewIfNeeded();
  await ta.click();                       // the <file-attachment> element needs the form live

  const input = page.locator('form:has(textarea#new_comment_field) input[type="file"]').first();
  await input.waitFor({ state: 'attached', timeout: 30000 });
  return {
    setFiles: (paths) => input.setInputFiles(paths),
    value: () => ta.inputValue(),
    clear: () => ta.fill(''),
  };
}

const readBody = () => execFileSync('gh', ['pr', 'view', pr, '--repo', REPO, '--json', 'body', '-q', '.body'], { encoding: 'utf8' });
const writeBody = (body) => execFileSync('gh', ['pr', 'edit', pr, '--repo', REPO, '--body-file', '-'], { input: body });
let result;
try {
  result = await runUpload({
    dir, readBody, writeBody, openPage,
    log: (l) => console.log(`[upload] #${pr} ${l}`),
    sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
  });
  // Roll the saved login forward with whatever GitHub refreshed during this run, so a session
  // that is used keeps working and nobody has to sign in again while uploads keep happening.
  if (ctx) {
    const fresh = await githubCookies(ctx);
    if (fresh.some((c) => c.name === 'user_session')) saveSession(PROFILE, user, fresh);
  }
} catch (e) {
  if (!(e instanceof UploadStop)) throw e;
  result = { code: e.code, lines: [e.message] };
} finally {
  if (ctx) await ctx.close();
}
const say = result.code === 0 || result.code === 4 ? console.log : console.error;
for (const l of result.lines) say(`[upload] ${l}`);
process.exitCode = result.code;
