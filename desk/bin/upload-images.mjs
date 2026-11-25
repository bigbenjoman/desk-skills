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
// Each file uploaded, and the one a stall stops on, is a line in the machine's upload log
// (upload-log.mjs, <DESK_HOME>/upload-log.jsonl).
//
// Everything below is load-bearing and each cost a failed run once:
//   - GitHub inserts an <img ...> tag into the textarea's VALUE, not a DOM node, and not
//     markdown. Waiting for an <img> element times out while the upload succeeded.
//   - The alt it writes DROPS the extension: before-desktop.png -> alt="before-desktop".
//   - The comment box is found by role and placeholder, the classic id only as a fallback
//     (pr-composer.mjs): GitHub's React PR page has no textarea#new_comment_field.
//   - The file input is hidden (state:'attached', not 'visible') and IS multiple; so is the add-files
//     button's file chooser, which the React page uses in its place (pr-composer.mjs).
//   - The box must be focused first or no POST to /upload/policies/assets ever fires.
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
//     tags file and their cells are filled, and the line printed says when it may run again. Also
//     GitHub's PR page changed: signed in, but no comment composer (or no file input in it) was
//     found, so nothing was uploaded; the line printed starts "GitHub's PR page changed".
//   8 paced: --max <n> was given and more images were left than that, so it uploaded n and stopped;
//     their cells are filled and the rest wait for the next run.
//
// pass.mjs runs it through the machine's one upload queue (upload-queue.mjs), which sets --max to
// what the pace leaves.
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runUpload, shotIndex, UploadStop } from './upload-batches.mjs';
import { logUpload, uploadLogFile } from './upload-log.mjs';
import { findComposer, EXIT_PAGE_CHANGED, NO_COMPOSER, NO_FILE_INPUT } from './pr-composer.mjs';
import { permission, permissionKey, browserProfile, ghRepo, DeskConfigError, psRows } from './desk-env.mjs';
import { runBatches } from './batches.mjs';
import { checkedShas } from './preview-db.mjs';
import { findPlaywright, importPlaywright, sessionFile, githubCookies, saveSession, loadSessionCookies, loginState } from './find-playwright.mjs';

// --state <dir>: the state dir of the batch whose job this is, where its PR's preview-database record
// is (pass.mjs passes it on every job, as a job another batch's pass runs has that pass's environment).
// By hand, without it, every batch of the repo is read (below).
const args = process.argv.slice(2);
const flags = {};
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max' || args[i] === '--state') flags[args[i].slice(2)] = args[++i];
  else rest.push(args[i]);
}
const max = 'max' in flags ? Number(flags.max) : null;
const [pr, dir] = rest;
if (!pr || !dir || rest.length > 2 || (max != null && !(Number.isInteger(max) && max > 0)) || ('state' in flags && !flags.state)) {
  console.error('usage: upload-images.mjs <pr-number> <image-dir> [--max <images>] [--state <batch state dir>]'); process.exit(1);
}
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

// A PR with a preview database posts only the files its last passing error-page check read, whichever
// route queued this upload: the advance step, the undraft step, a crashed upload tried again, a paced job.
// The record is read from --state; else, run by hand, from every batch of this repo (the one pinned by
// DESK_BATCH or DESK_AUTOPILOT_STATE, or with none pinned each one listed), as the person's shell names
// no batch while the PR's record may sit in a named one. Two batches holding a record for it is refused.
let passed;
try {
  const states = flags.state ? [flags.state] : runBatches().map((b) => b.state);
  const found = states.map((s) => ({ s, shas: checkedShas(s, pr) })).filter((x) => x.shas);
  if (found.length > 1) throw new Error(`more than one batch holds a preview-database record for it (${found.map((x) => x.s).join(', ')}); name one with --state`);
  passed = found[0]?.shas ?? null;
} catch (e) {
  console.error(`[upload] whether PR #${pr} has a preview database could not be read (${e.message}), so nothing is uploaded`);
  process.exit(6);
}

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

  // Signed in with no composer is GitHub changing its page, not a flake: said once, with no trace.
  const composer = await findComposer(page);
  if (!composer) throw new UploadStop(EXIT_PAGE_CHANGED, NO_COMPOSER);
  if (!composer.setFiles) throw new UploadStop(EXIT_PAGE_CHANGED, NO_FILE_INPUT);
  const { textarea: ta, setFiles } = composer;
  return {
    setFiles,
    value: () => ta.inputValue(),
    clear: () => ta.fill(''),
  };
}

// Every file uploaded, and the one a stall or upload error stopped on, goes in the machine's
// upload log; a log that cannot be written never stops an upload.
const record = (file, result, at) => {
  try { logUpload({ repo: REPO, pr, file, result, at }); } catch (e) { console.error(`[upload] the upload log was not written: ${e.message}`); return; }
  if (result === 'throttled') console.error(`[upload] stalled on ${file}, logged as throttled in ${uploadLogFile()}`);
};

const readBody = () => execFileSync('gh', ['pr', 'view', pr, '--repo', REPO, '--json', 'body', '-q', '.body'], { encoding: 'utf8' });
const writeBody = (body) => execFileSync('gh', ['pr', 'edit', pr, '--repo', REPO, '--body-file', '-'], { input: body });
let result;
try {
  result = await runUpload({
    dir, readBody, writeBody, openPage, record, max, passed,
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
