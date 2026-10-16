// findPlaywright: the repo's own Playwright, wherever its package manager put it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findPlaywright } from '../desk/bin/find-playwright.mjs';
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

const none = repo();
const miss = findPlaywright(none);
t('nothing installed', miss.entry, null);
t('nothing installed lists what it tried', miss.tried.length > 0, true);

process.env.DESK_PLAYWRIGHT = top;
t('DESK_PLAYWRIGHT first', findPlaywright(pnpm).entry, top);
delete process.env.DESK_PLAYWRIGHT;

for (const r of [hoisted, pnpm, none]) rmSync(r, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
