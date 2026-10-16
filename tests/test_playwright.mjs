// findPlaywright: the repo's own Playwright, wherever its package manager put it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findPlaywright, sessionFile, githubCookies, saveSession, loadSessionCookies } from '../desk/bin/find-playwright.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const repo = () => { const r = mkdtempSync(join(tmpdir(), 'desk-pw-')); writeFileSync(join(r, 'package.json'), '{}'); return r; };
const put = (r, ...p) => { mkdirSync(join(r, ...p), { recursive: true }); const f = join(r, ...p, 'index.mjs'); writeFileSync(f, ''); return f; };
delete process.env.DESK_PLAYWRIGHT;

const hoisted = repo();
const top = put(hoisted, 'node_modules', 'playwright');
put(hoisted, 'node_modules', '.pnpm', 'playwright@1.55.0', 'node_modules', 'playwright');
t('hoisted node_modules wins', findPlaywright(hoisted).entry, top);

const pnpm = repo();
put(pnpm, 'node_modules', '.pnpm', 'playwright-core@1.56.0', 'node_modules', 'playwright');
put(pnpm, 'node_modules', '.pnpm', 'playwright@1.9.0', 'node_modules', 'playwright');
const newest = put(pnpm, 'node_modules', '.pnpm', 'playwright@1.55.0', 'node_modules', 'playwright');
t('pnpm store only: newest playwright@, never playwright-core', findPlaywright(pnpm).entry, newest);

const coreOnly = repo();
put(coreOnly, 'node_modules', '.pnpm', 'playwright-core@1.56.0', 'node_modules', 'playwright');
t('pnpm store with only playwright-core', findPlaywright(coreOnly).entry, null);

const none = repo();
const miss = findPlaywright(none);
t('nothing installed', miss.entry, null);
t('nothing installed lists what it tried', miss.tried.length > 0, true);

process.env.DESK_PLAYWRIGHT = top;
t('DESK_PLAYWRIGHT first', findPlaywright(pnpm).entry, top);
delete process.env.DESK_PLAYWRIGHT;

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

for (const r of [hoisted, pnpm, coreOnly, none, dir]) rmSync(r, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
