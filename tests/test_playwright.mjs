// suite: playwright lookup and saved GitHub login
// findPlaywright: desk's own pinned Playwright, never the repo's; DESK_PLAYWRIGHT overrides it.
// The saved login: a storage state, and whether it is missing or expired before a browser opens.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findPlaywright, importPlaywright, sessionFile, githubCookies, saveSession, loadSessionCookies, loginState } from '../desk/bin/find-playwright.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const put = (r, ...p) => { mkdirSync(join(r, ...p), { recursive: true }); const f = join(r, ...p, 'index.mjs'); writeFileSync(f, 'export const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;\n'); return f; };
delete process.env.DESK_PLAYWRIGHT;
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');

// A repo with its own Playwright, run from inside it: desk's copy still wins.
const repo = mkdtempSync(join(tmpdir(), 'desk-pw-repo-'));
writeFileSync(join(repo, 'package.json'), '{}');
const repoOwn = put(repo, 'node_modules', 'playwright');
const cwd = process.cwd();
process.chdir(repo);
const desk = mkdtempSync(join(tmpdir(), 'desk-pw-home-'));
const own = put(desk, 'playwright', 'node_modules', 'playwright');
const found = findPlaywright(desk);
t("desk's copy first", found.entry, own);
t("desk's copy runs on desk's browsers", found.browsers, join(desk, 'playwright', 'browsers'));

const none = mkdtempSync(join(tmpdir(), 'desk-pw-none-'));
const miss = findPlaywright(none);
t("no desk copy: the repo's own is never used", miss.entry, null);
t('nothing installed lists what it tried', miss.tried.join(','), join(none, 'playwright', 'node_modules', 'playwright', 'index.mjs'));
process.chdir(cwd);

process.env.DESK_PLAYWRIGHT = repoOwn;
const over = findPlaywright(desk);
t('DESK_PLAYWRIGHT overrides it', over.entry, repoOwn);
t('DESK_PLAYWRIGHT keeps its own browsers', over.browsers, null);
delete process.env.DESK_PLAYWRIGHT;

// The browsers path is in place before Playwright first reads it, and left alone for an override.
process.env.PLAYWRIGHT_BROWSERS_PATH = '/elsewhere';
t('import sets the browsers path first', (await importPlaywright(found)).browsers, found.browsers);
process.env.PLAYWRIGHT_BROWSERS_PATH = '/elsewhere';
await importPlaywright(over);
t('an override import leaves the browsers path', process.env.PLAYWRIGHT_BROWSERS_PATH, '/elsewhere');
delete process.env.PLAYWRIGHT_BROWSERS_PATH;

// The saved GitHub login: github.com cookies only, owner-only on every write.
const dir = mkdtempSync(join(tmpdir(), 'desk-session-'));
const profile = join(dir, 'desk-profile');
const ctx = { cookies: async () => [
  { name: 'user_session', domain: 'github.com' }, { name: '_gh_sess', domain: '.github.com' },
  { name: 'x', domain: 'gist.github.com' }, { name: 'y', domain: 'notgithub.com' }, { name: 'z', domain: 'example.com' }] };
t('github cookies only', (await githubCookies(ctx)).map((c) => c.name).join(','), 'user_session,_gh_sess,x');
t('no session file loads nothing', loadSessionCookies(profile).length, 0);
writeFileSync(sessionFile(profile), '{}', { mode: 0o644 });
const file = saveSession(profile, 'me', await githubCookies(ctx));
t('re-save tightens a wider file to 0600', (statSync(file).mode & 0o777).toString(8), '600');
t('saved cookies load back', loadSessionCookies(profile).length, 3);
t('the saved login is a storage state the MCP can load', JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).origins), '[]');

// Before a browser opens: no login, an expired one, and one only GitHub can judge.
const at = (expires) => [{ name: 'user_session', domain: 'github.com', expires }];
const NOW = Date.parse('2026-10-18T12:00:00Z');
writeFileSync(file, '{"cookies": [], "origins": []}');
t("install.sh's empty placeholder reads as no login", loginState(profile, NOW).status, 'missing');
saveSession(profile, 'me', at(NOW / 1000 - 60));
t('a login cookie past its expiry reads as expired', loginState(profile, NOW).status, 'expired');
t('the expiry says when', loginState(profile, NOW).expiredAt, '2026-10-18T11:59:00.000Z');
saveSession(profile, 'me', at(NOW / 1000 + 60));
t('a login cookie not yet expired is ok', loginState(profile, NOW).status, 'ok');
saveSession(profile, 'me', at(-1));
t('a session cookie is left to the page check', loginState(profile, NOW).status, 'ok');
t('no file at all is no login', loginState(join(dir, 'other'), NOW).status, 'missing');

// github-signin.mjs end to end, on a fake Playwright: its browser "signs in" as FAKE_LOGIN (or never,
// when that is empty) and holds the cookies above. No real browser, GitHub or ~/.claude.
const fake = join(dir, 'fake-playwright.mjs');
writeFileSync(fake, `const cookies = ${JSON.stringify(await ctx.cookies())};
const page = { goto: async () => {}, waitForTimeout: async () => {}, evaluate: async () => process.env.FAKE_LOGIN };
export const chromium = { launchPersistentContext: async () => ({ pages: () => [page], newPage: async () => page, cookies: async () => cookies, close: async () => {} }) };
`);
const signin = (env) => spawnSync(process.execPath, [join(BIN, 'github-signin.mjs')], {
  encoding: 'utf8', env: { ...process.env, HOME: dir, DESK_HOME: join(dir, 'desk'), DESK_BROWSER_PROFILE: join(dir, 'signin-profile'), ...env },
});
const signed = signin({ DESK_PLAYWRIGHT: fake, FAKE_LOGIN: 'octocat' });
const saved = JSON.parse(readFileSync(sessionFile(join(dir, 'signin-profile')), 'utf8'));
t('signin: a signed-in page exits 0', signed.status, 0);
t('signin: it saves the login under the page\'s user', saved.user, 'octocat');
t('signin: only the github.com cookies are saved', saved.cookies.map((c) => c.name).join(','), 'user_session,_gh_sess,x');
t('signin: the saved file is owner-only', (statSync(sessionFile(join(dir, 'signin-profile'))).mode & 0o777).toString(8), '600');
const never = signin({ DESK_PLAYWRIGHT: fake, DESK_BROWSER_PROFILE: join(dir, 'never-profile'), FAKE_LOGIN: '' });
t('signin: no sign-in within the wait exits 1', never.status, 1);
t('signin: and saves nothing', existsSync(sessionFile(join(dir, 'never-profile'))), false);
const noPw = signin({ DESK_PLAYWRIGHT: '' });
t('signin: no Playwright exits 6', noPw.status, 6);
t('signin: and names what it tried', noPw.stderr.includes(join(dir, 'desk', 'playwright')), true);

for (const r of [repo, desk, none, dir]) rmSync(r, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
