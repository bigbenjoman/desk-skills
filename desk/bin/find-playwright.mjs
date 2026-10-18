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
// here (owner-only) as a Playwright storage-state file: upload-images.mjs adds them back to each
// run's context, and Claude's Playwright MCP, which install.sh registers at user level with
// --isolated --storage-state <this file>, starts every session from it. One file per machine.
export const sessionFile = (profile) => `${profile.replace(/\/+$/, '')}.github-session.json`;

export const githubCookies = async (ctx) =>
  (await ctx.cookies()).filter((c) => /(^|\.)github\.com$/.test(c.domain.replace(/^\./, '')));

// `origins` makes it a storage state the MCP can load; `user` and `savedAt` are ours, and Playwright
// ignores them.
export function saveSession(profile, user, cookies) {
  const file = sessionFile(profile);
  writeFileSync(file, JSON.stringify({ user, savedAt: new Date().toISOString(), cookies, origins: [] }, null, 1), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function loadSessionCookies(profile) {
  const file = sessionFile(profile);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).cookies ?? [] : [];
}

// What the saved login can say without opening a browser: 'missing' (no file, or no login cookie in
// it, as install.sh's empty placeholder) or 'expired' (every login cookie carries an expiry, and all
// have passed). 'ok' means not known to be stale: a session cookie has no expiry, so only GitHub can
// tell, and the uploader still checks the page.
export function loginState(profile, now = Date.now()) {
  const file = sessionFile(profile);
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const logins = (saved.cookies ?? []).filter((c) => c.name === 'user_session');
  if (!logins.length) return { file, status: 'missing' };
  const expires = logins.map((c) => c.expires ?? -1);
  const status = expires.every((e) => e > 0 && e * 1000 <= now) ? 'expired' : 'ok';
  return { file, status, user: saved.user, expiredAt: status === 'expired' ? new Date(Math.max(...expires) * 1000).toISOString() : null };
}
