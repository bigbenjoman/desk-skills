// The Playwright upload-images.mjs and github-signin.mjs run on: desk's own pinned copy, which
// install.sh puts in ~/.claude/desk/playwright with its browsers in browsers/ there, so every repo opens the
// shared profile with the same Chromium build. A repo's own Playwright is its e2e tests', never read.
// DESK_PLAYWRIGHT (a path to some playwright's index.mjs) overrides it, on that copy's own browsers.
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deskHome } from './desk-env.mjs';

export function findPlaywright(desk = deskHome()) {
  const own = join(desk, 'playwright');
  const candidates = [];
  if (process.env.DESK_PLAYWRIGHT) candidates.push({ entry: process.env.DESK_PLAYWRIGHT, browsers: null });
  candidates.push({ entry: join(own, 'node_modules', 'playwright', 'index.mjs'), browsers: join(own, 'browsers') });
  const tried = [];
  for (const c of candidates) { tried.push(c.entry); if (existsSync(c.entry)) return { ...c, tried }; }
  return { entry: null, browsers: null, tried };
}

// Playwright reads PLAYWRIGHT_BROWSERS_PATH once, when it is first imported, so it is set first.
export async function importPlaywright({ entry, browsers }) {
  if (browsers) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  return import(pathToFileURL(entry).href);
}

// GitHub sets its login cookies as session cookies, which Chromium drops when the browser exits,
// so a signed-in profile reads as signed out on its next launch. github-signin.mjs saves them
// here (owner-only); upload-images.mjs adds them back to each run's context.
export const sessionFile = (profile) => `${profile.replace(/\/+$/, '')}.github-session.json`;

export const githubCookies = async (ctx) =>
  (await ctx.cookies()).filter((c) => /(^|\.)github\.com$/.test(c.domain.replace(/^\./, '')));

export function saveSession(profile, user, cookies) {
  const file = sessionFile(profile);
  writeFileSync(file, JSON.stringify({ user, savedAt: new Date().toISOString(), cookies }, null, 1), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function loadSessionCookies(profile) {
  const file = sessionFile(profile);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).cookies ?? [] : [];
}
