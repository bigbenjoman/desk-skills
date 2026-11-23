// suite: pr-composer (finding a PR page's new-comment composer, React and classic)
// layer: L2
// findComposer against saved DOM fixtures (tests/fixtures/github-pr/) in desk's own headless
// Chromium, skipped where that is not installed. Then upload-images.mjs end to end on a signed-in
// page with no composer and on a signed-out one: against a fake Playwright, and, with desk's
// Playwright, against the fixtures served in a real browser. No network, no real profile or GitHub.
// DESK_COMPOSER_SMOKE=<owner/repo>#<pr> opts in to a run against that live PR in the signed-in
// profile: it finds the composer and its file input or add-files button, and uploads nothing.
// DESK_COMPOSER_CAPTURE=<file> with it saves that page, focused and stripped of its tokens, to build
// a fixture from.
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findComposer, NO_COMPOSER } from '../desk/bin/pr-composer.mjs';
import { uploadSandbox } from './upload_harness.mjs';
import { findPlaywright, importPlaywright, loadSessionCookies } from '../desk/bin/find-playwright.mjs';
import { browserProfile, psRows } from '../desk/bin/desk-env.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => {
  const g = typeof got === 'string' ? got : JSON.stringify(got); const w = typeof want === 'string' ? want : JSON.stringify(want);
  const ok = g === w; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`);
};
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'github-pr');
const fixture = (name) => join(FIX, `${name}.html`);
const T = scratch('desk-pr-composer-');

// ---- upload-images.mjs on a stub gh, a scratch config and a saved login ------------------------
const { images, fakes, upload } = uploadSandbox(T, { user: 'octocat' });
writeFileSync(join(images, 'after-desktop.png'), 'png');
writeFileSync(join(fakes, 'gh'), '#!/bin/sh\necho "| _drag after-desktop.png_ |"\n');
chmodSync(join(fakes, 'gh'), 0o755);
const SIGN_IN = 'the saved GitHub login has expired';
const noTrace = (out) => !/TimeoutError|locator\.|waitFor|^\s+at /m.test(out);

// A fake Playwright whose page is signed in as FAKE_LOGIN (signed out when empty) and never shows a
// composer: every wait times out at once, as Playwright's does once its timeout passes.
writeFileSync(join(T, 'fake-pw.mjs'), `
const timeout = () => { const e = new Error('Timeout exceeded'); e.name = 'TimeoutError'; return e; };
const loc = { or: () => loc, first: () => loc, last: () => loc, locator: () => loc, count: async () => 0,
  waitFor: async () => { throw timeout(); } };
const page = { goto: async () => {}, evaluate: async () => process.env.FAKE_LOGIN, locator: () => loc, getByRole: () => loc };
const ctx = { addCookies: async () => {}, pages: () => [page], newPage: async () => page, cookies: async () => [], close: async () => {} };
export const chromium = { launchPersistentContext: async () => ctx };
`);
let r = upload({ DESK_PLAYWRIGHT: join(T, 'fake-pw.mjs'), FAKE_LOGIN: 'octocat' });
t('AC4 (fake): signed in with no composer exits 7', `${r.status}`, '7');
t('AC4 (fake): it says GitHub\'s PR page changed', r.stderr.includes(`[upload] ${NO_COMPOSER}`), true);
t('AC4 (fake): with no Playwright timeout trace', noTrace(r.out), true);
r = upload({ DESK_PLAYWRIGHT: join(T, 'fake-pw.mjs'), FAKE_LOGIN: '' });
t('AC5 (fake): signed out still exits 6', `${r.status}`, '6');
t('AC5 (fake): with the sign-in message', r.stderr.includes(SIGN_IN) && r.stderr.includes('github-signin.mjs'), true);

// ---- in a real browser: desk's own Playwright, skipped where it is not installed --------------
const pw = findPlaywright();
if (!pw.entry) {
  console.log(`SKIP composer fixtures in a browser: no desk Playwright (tried ${pw.tried.join(', ')})`);
} else {
  const { chromium } = await importPlaywright(pw);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const open = async (name) => { await page.setContent(readFileSync(fixture(name), 'utf8')); };
  const which = (l) => l.evaluate((el) => el.closest('[data-composer]')?.dataset.composer ?? 'none');
  const opts = { wait: 3000, focus: 2000 };

  await open('react');
  t('AC1: the React page has no textarea#new_comment_field, so the old selector finds nothing', await page.locator('textarea#new_comment_field').count(), 0);
  let c = await findComposer(page, opts);
  t('AC1: the React composer\'s textarea is found', c ? `${await c.textarea.getAttribute('id')} ${await which(c.textarea)}` : 'null', '_r_24_ new');
  t('AC1: and its file input, rendered once the box is focused', c?.input ? `${await c.input.getAttribute('type')} ${await which(c.input)}` : 'null', 'file new');

  await open('classic');
  c = await findComposer(page, opts);
  t('AC2: the classic page gives textarea#new_comment_field', c ? await c.textarea.getAttribute('id') : 'null', 'new_comment_field');
  t('AC2: and its form\'s file input', c?.input ? await c.input.evaluate((el) => el.closest('form')?.querySelector('textarea')?.id ?? 'none') : 'null', 'new_comment_field');
  // Without the placeholder only the legacy id can find it: the fallback itself, not the placeholder.
  await page.evaluate(() => document.querySelector('#new_comment_field').removeAttribute('placeholder'));
  c = await findComposer(page, opts);
  t('AC2: by the legacy id alone, with no role or placeholder to match', c ? await c.textarea.getAttribute('id') : 'null', 'new_comment_field');
  t('AC2: and still its form\'s file input', c?.input ? await which(c.input) : 'null', 'new');

  await open('react-threads');
  c = await findComposer(page, opts);
  t('AC3: with review threads, the bottom new-comment composer is found, not a reply box', c ? `${await c.textarea.getAttribute('id')} ${await which(c.textarea)}` : 'null', '_r_24_ new');
  t('AC3: and the file input is the composer\'s own', c?.input ? await which(c.input) : 'null', 'new');
  // A reply box already focused has its file input; a composer that never mounts one must not take it.
  await open('react-threads');
  await page.focus('#_r_9_');
  await page.evaluate(() => { const ta = document.querySelector('#_r_24_'); ta.replaceWith(ta.cloneNode()); });
  c = await findComposer(page, opts);
  t('AC3: a reply box\'s mounted file input is never taken for the composer\'s', c ? `${await which(c.textarea)} ${c.input ? await which(c.input) : 'no input'}` : 'null', 'new no input');

  // A React page that mounts no file input: its add-files button opens a chooser.
  await open('react-add-files');
  c = await findComposer(page, opts);
  t('add-files: with no file input, the composer is still found', c ? `${await c.textarea.getAttribute('id')} ${await which(c.textarea)}` : 'null', '_r_24_ new');
  t('add-files: with no input, and a setFiles through the add-files button', c ? `${c.input} ${typeof c.setFiles}` : 'null', 'null function');
  if (c?.setFiles) {
    const png = join(T, 'shot.png'); writeFileSync(png, 'png');
    await c.setFiles([png]);
    t('add-files: setFiles uploads into the composer, not the reply box', `${await c.textarea.inputValue()} | ${await page.locator('#_r_9_').inputValue()}`, '<img alt="shot.png" src="https://github.com/user-attachments/assets/new-shot.png" /> | ');
  }
  t('add-files: the React page with an input still uses it', (await (async () => { await open('react'); const r = await findComposer(page, opts); return r?.input ? typeof r.setFiles : 'no input'; })()), 'function');

  // GitHub's page as served now (react-current.html, cut from a capture of a live PR) has no file
  // input anywhere, only the add-files button.
  await open('react-current');
  await page.waitForSelector('#_r_24_');
  t('current page: its mounted composer has no input[type=file]', await page.locator('input[type="file"]').count(), 0);
  c = await findComposer(page, opts);
  t('current page: nor once findComposer has focused it', await page.locator('input[type="file"]').count(), 0);
  t('current page: its composer\'s textarea is found', c ? `${await c.textarea.getAttribute('id')} ${await which(c.textarea)}` : 'null', '_r_24_ new');
  t('current page: it takes files through the add-files button\'s chooser', c ? `${c.input} ${typeof c.setFiles}` : 'null', 'null function');
  writeFileSync(join(T, 'one.png'), 'png'); writeFileSync(join(T, 'two.png'), 'png'); writeFileSync(join(T, 'three.png'), 'png');
  await c?.setFiles?.([join(T, 'one.png'), join(T, 'two.png')]);
  await c?.setFiles?.([join(T, 'three.png')]);
  const tags = c ? await c.textarea.inputValue() : '';
  t('current page: files set reach the composer as GitHub\'s image tags, each call a new chooser', `${(tags.match(/alt="(one|two|three)"/g) ?? []).join(' ')} ${await page.evaluate(() => window.chosen ?? 0)}`, 'alt="one" alt="two" alt="three" 2');
  // A focused composer with no file input and no add-files button is still a page change.
  await open('react-current');
  await page.waitForSelector('#_r_24_');
  await page.evaluate(() => document.querySelector('.container__Sx9cv_').remove());
  c = await findComposer(page, opts);
  t('current page: with neither a file input nor the add-files button, no way to add files', c ? `${await which(c.textarea)} ${c.setFiles ? 'setFiles' : 'none'}` : 'null', 'new none');

  await open('no-composer');
  const t0 = Date.now();
  c = await findComposer(page, opts);
  t('no composer by role, placeholder or legacy id is null', c, null);
  t('and is said once the wait passes, not later', Date.now() - t0 < opts.wait + 2000, true);
  await browser.close();

  // upload-images.mjs end to end in a real browser, its PR page served from a fixture.
  writeFileSync(join(T, 'served-pw.mjs'), `
import { readFileSync } from 'node:fs';
const real = await import(${JSON.stringify(pw.entry)});
export const chromium = { launchPersistentContext: async (_profile, opts) => {
  const browser = await real.chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: opts?.viewport });
  await ctx.route('**/*', (r) => r.fulfill({ contentType: 'text/html', body: readFileSync(process.env.FIXTURE, 'utf8') }));
  const close = ctx.close.bind(ctx);
  ctx.close = async () => { await close(); await browser.close(); };
  return ctx;
} };
`);
  const served = (name) => upload({ DESK_PLAYWRIGHT: join(T, 'served-pw.mjs'), PLAYWRIGHT_BROWSERS_PATH: pw.browsers ?? process.env.PLAYWRIGHT_BROWSERS_PATH ?? '', FIXTURE: fixture(name) });
  r = served('no-composer');
  t('AC4: a signed-in page with no composer exits 7', `${r.status}`, '7');
  t('AC4: within 30 seconds', r.ms < 30000, true);
  t('AC4: printing that GitHub\'s PR page changed', r.stderr.includes(`[upload] ${NO_COMPOSER}`), true);
  t('AC4: with no Playwright timeout trace', noTrace(r.out), true);
  r = served('signed-out');
  t('AC5: a signed-out page still exits 6', `${r.status}`, '6');
  t('AC5: with the sign-in message', r.stderr.includes(SIGN_IN), true);

  // End to end: on the current page one image is uploaded and its tag reaches the body.
  // This gh keeps the body it is given, so the run reads back what it wrote. Last: the run leaves
  // its tags file beside the images.
  const bodyOut = join(T, 'edited-body.md');
  writeFileSync(join(fakes, 'gh'), '#!/bin/sh\nif [ "$2" = edit ]; then cat > "$GH_BODY_OUT"; elif [ -f "$GH_BODY_OUT" ]; then cat "$GH_BODY_OUT"; else echo "| _drag after-desktop.png_ |"; fi\n');
  r = upload({ DESK_PLAYWRIGHT: join(T, 'served-pw.mjs'), PLAYWRIGHT_BROWSERS_PATH: pw.browsers ?? process.env.PLAYWRIGHT_BROWSERS_PATH ?? '', FIXTURE: fixture('react-current'), GH_BODY_OUT: bodyOut });
  t('current page: an upload exits 0', `${r.status}`, '0');
  if (r.status) console.log(r.out);
  let edited = ''; try { edited = readFileSync(bodyOut, 'utf8'); } catch { /* not written */ }
  t('current page: and the PR body gets the image in place of its placeholder', edited.includes('https://github.com/user-attachments/assets/after-desktop-0001') && !edited.includes('_drag after-desktop.png_') ? 'replaced' : edited, 'replaced');
}

// ---- AC6: the live smoke test, only when asked for --------------------------------------------
const smoke = process.env.DESK_COMPOSER_SMOKE ?? '';
if (!smoke) {
  console.log('SKIP live composer smoke test: set DESK_COMPOSER_SMOKE=<owner/repo>#<pr> to run it (it uses the network and the signed-in profile)');
} else if (!pw.entry) {
  t('smoke: needs desk Playwright', 'not installed', 'installed');
} else {
  const [, repo, pr] = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(smoke) ?? [];
  const profile = browserProfile();
  const held = psRows('pid=,args=').some((p) => p.args.includes(`user-data-dir=${profile}`));
  if (!repo) t('smoke: DESK_COMPOSER_SMOKE is <owner/repo>#<pr>', smoke, '<owner/repo>#<pr>');
  else if (held) t('smoke: the shared profile is free', 'in use', 'free');
  else {
    const { chromium } = await importPlaywright(pw);
    const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1400, height: 1200 } });
    try {
      await ctx.addCookies(loadSessionCookies(profile));
      const page = ctx.pages()[0] ?? await ctx.newPage();
      await page.goto(`https://github.com/${repo}/pull/${pr}`, { waitUntil: 'domcontentloaded' });
      const user = await page.evaluate(() => document.querySelector('meta[name="user-login"]')?.content || '');
      t(`smoke: ${repo}#${pr} is signed in`, user ? 'signed in' : 'signed out', 'signed in');
      const c = await findComposer(page);
      const desc = c ? await c.textarea.evaluate((el) => `${el.id} placeholder="${el.placeholder}" aria-label="${el.getAttribute('aria-label')}"`) : 'none';
      console.log(`smoke: composer textarea: ${desc}; files go in by ${c?.input ? 'input' : c?.setFiles ? 'chooser' : 'nothing'}`);
      t(`smoke: ${repo}#${pr} has a composer`, !!c, true);
      t(`smoke: ${repo}#${pr}'s composer has a way to add files once focused (nothing is uploaded)`, !!c?.setFiles, true);
      // DESK_COMPOSER_CAPTURE=<file> also saves the page as it stands once the composer is focused, to
      // build a fixture from: no scripts, styles or svg paths, and no hidden input's value or meta
      // content, which hold the session's tokens. Nothing is uploaded.
      if (process.env.DESK_COMPOSER_CAPTURE) {
        const html = await page.evaluate(() => {
          const doc = document.documentElement.cloneNode(true);
          doc.querySelectorAll('script, style, link, noscript, template, svg *').forEach((el) => el.remove());
          doc.querySelectorAll('input[type="hidden"]').forEach((el) => el.removeAttribute('value'));
          doc.querySelectorAll('meta').forEach((el) => el.removeAttribute('content'));
          return `<!doctype html>\n${doc.outerHTML}`;
        });
        writeFileSync(process.env.DESK_COMPOSER_CAPTURE, html);
        console.log(`smoke: saved the focused page to ${process.env.DESK_COMPOSER_CAPTURE} (${html.length} chars)`);
      }
    } finally { await ctx.close(); }
  }
}

rmSync(T, { recursive: true, force: true });
console.log(`${fails ? 'FAIL ' : ''}${fails} failed`);
process.exit(fails ? 1 : 0);
