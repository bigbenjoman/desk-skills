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
// Exit codes (pass.mjs and desk-pr read these):
//   0 uploaded, every placeholder replaced      3 uploaded, but no `_drag <file>_` placeholder matched (tags on stderr)
//   1 bad arguments, no such dir, no images     4 uploaded, but placeholder(s) are still left in the body
//   2 the shared profile is in use (retry)      5 not permitted: config §3 pr-images is not yes and no DESK_UPLOAD_APPROVED
//   6 setup or config: browser profile unset or missing, playwright not installed
import { readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { HOME, permission, permissionKey, browserProfile, repoRoot, ghRepo, DeskConfigError } from './desk-env.mjs';

const [pr, dir] = process.argv.slice(2);
if (!pr || !dir) { console.error('usage: upload-images.mjs <pr-number> <image-dir>'); process.exit(1); }
if (!existsSync(dir)) { console.error(`no such directory: ${dir}`); process.exit(1); }

const perm = permission('pr-images');
if (perm !== 'yes' && !process.env.DESK_UPLOAD_APPROVED) {
  console.error(`[upload] config §3 ${permissionKey('pr-images')} is ${perm} — ` +
    'ask the user, then re-run with DESK_UPLOAD_APPROVED=1. Not uploading.');
  process.exit(5);
}

// The profile is signed in as a person, so it is identity-shaped: never auto-pick one.
let PROFILE;
try {
  PROFILE = browserProfile();
} catch (e) {
  if (!(e instanceof DeskConfigError)) throw e;
  const candidates = [join(HOME, '.cache', 'ms-playwright-mcp'), join(HOME, 'Library', 'Caches', 'ms-playwright-mcp')]
    .flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.startsWith('mcp-')).map((f) => join(d, f)) : []));
  console.error(e.message);
  if (candidates.length) console.error(`[upload] candidate profiles found (confirm which is signed in to GitHub):\n  ${candidates.join('\n  ')}`);
  process.exit(6);
}
if (!existsSync(PROFILE)) { console.error(`[upload] browser profile does not exist: ${PROFILE}`); process.exit(6); }

const REPO = ghRepo();
// Playwright is not ours to install: use the one this repo already has (its node_modules, or wherever
// node resolves it from the repo root, which covers hoisted workspaces), else DESK_PLAYWRIGHT
// (a path to playwright's index.mjs, for a repo that is not a JS project).
function findPlaywright() {
  const tried = [];
  const candidates = [];
  if (process.env.DESK_PLAYWRIGHT) candidates.push(process.env.DESK_PLAYWRIGHT);
  const root = repoRoot();
  candidates.push(join(root, 'node_modules', 'playwright', 'index.mjs'));
  try {
    const req = createRequire(join(root, 'package.json'));
    candidates.push(join(dirname(req.resolve('playwright/package.json')), 'index.mjs'));
  } catch { /* not resolvable from the repo */ }
  for (const c of candidates) { tried.push(c); if (existsSync(c)) return { entry: c, tried }; }
  return { entry: null, tried };
}
const { entry: playwrightEntry, tried } = findPlaywright();
if (!playwrightEntry) {
  console.error(`[upload] playwright not found (tried: ${tried.join(', ')}). Install the repo's dependencies ` +
    '(config §4 Install), or point DESK_PLAYWRIGHT at an installed playwright/index.mjs.');
  process.exit(6);
}
const { chromium } = await import(pathToFileURL(playwrightEntry).href);

const files = readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
if (!files.length) { console.error(`no images in ${dir}`); process.exit(1); }
console.log(`[upload] #${pr} <- ${files.length} image(s) from ${dir}`);

// Refuse to run two at once: the profile has a single lock and a collision either kills
// the browser or closes the page mid-upload. `ps` rather than `pgrep -a` (procps-only).
const holders = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' })
  .split('\n')
  .filter((l) => l.includes(`user-data-dir=${PROFILE}`) && !l.includes('upload-images.mjs'))
  .join('\n').trim();
if (holders) { console.error(`[upload] the shared profile is in use — refusing:\n${holders}`); process.exit(2); }

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 1200 } });
try {
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(`https://github.com/${REPO}/pull/${pr}`, { waitUntil: 'domcontentloaded' });

  const ta = page.locator('textarea#new_comment_field');
  await ta.waitFor({ state: 'attached', timeout: 30000 });
  await ta.scrollIntoViewIfNeeded();
  await ta.click();                       // the <file-attachment> element needs the form live

  const input = page.locator('form:has(textarea#new_comment_field) input[type="file"]').first();
  await input.waitFor({ state: 'attached', timeout: 30000 });
  await input.setInputFiles(files.map((f) => join(dir, f)));

  for (const f of files) {
    const base = f.replace(/\.[^.]+$/, '');
    await page.waitForFunction(
      ({ base: b, f: file }) => {
        const t = document.querySelector('textarea#new_comment_field')?.value ?? '';
        return new RegExp(`<img[^>]*alt="${b}"[^>]*src="https://github.com/user-attachments/assets/`).test(t)
          && !t.includes(`Uploading ${file}`);
      },
      { base, f },
      { timeout: 180000 },
    );
    console.log(`[upload]   ${f}`);
  }

  const value = await ta.inputValue();
  const tags = {};
  for (const m of value.matchAll(/<img[^>]*alt="([^"]+)"[^>]*src="[^"]+"[^>]*>/g)) tags[m[1]] = m[0];
  await ta.fill('');                      // clear, never submit

  // Swap the placeholders in the PR body. The worker writes `_drag <file>_` cells.
  let body = execFileSync('gh', ['pr', 'view', pr, '--repo', REPO, '--json', 'body', '-q', '.body'], { encoding: 'utf8' });
  let swapped = 0;
  for (const [alt, tag] of Object.entries(tags)) {
    for (const ph of [`_drag ${alt}.png_`, `_drag ${alt}.jpg_`, `_drag ${alt}.jpeg_`]) {
      if (body.includes(ph)) { body = body.split(ph).join(tag); swapped += 1; }
    }
  }
  if (!swapped) {
    console.error('[upload] uploaded, but found no `_drag <file>_` placeholders to replace.');
    console.error('[upload] tags, so they are not lost:');
    console.error(JSON.stringify(tags, null, 2));
    process.exit(3);
  }
  execFileSync('gh', ['pr', 'edit', pr, '--repo', REPO, '--body-file', '-'], { input: body });

  const after = execFileSync('gh', ['pr', 'view', pr, '--repo', REPO, '--json', 'body', '-q', '.body'], { encoding: 'utf8' });
  const live = (after.match(/user-attachments\/assets/g) ?? []).length;
  const left = (after.match(/_drag /g) ?? []).length;
  console.log(`[upload] done: ${live} image(s) in the body, ${left} placeholder(s) left`);
  if (left) process.exitCode = 4;
} finally {
  await ctx.close();
}
