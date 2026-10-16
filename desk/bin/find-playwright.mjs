// Where the repo's own Playwright lives, shared by upload-images.mjs and github-signin.mjs.
// Playwright is not ours to install: use the one this repo already has (its node_modules, or wherever
// node resolves it from the repo root, which covers hoisted workspaces, or pnpm's store when a
// workspace package depends on it and nothing hoists it), else DESK_PLAYWRIGHT (a path to
// playwright's index.mjs, for a repo that is not a JS project).
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { repoRoot } from './desk-env.mjs';

export function findPlaywright(root = repoRoot()) {
  const tried = [];
  const candidates = [];
  if (process.env.DESK_PLAYWRIGHT) candidates.push(process.env.DESK_PLAYWRIGHT);
  candidates.push(join(root, 'node_modules', 'playwright', 'index.mjs'));
  try {
    const req = createRequire(join(root, 'package.json'));
    candidates.push(join(dirname(req.resolve('playwright/package.json')), 'index.mjs'));
  } catch { /* not resolvable from the repo */ }
  const store = join(root, 'node_modules', '.pnpm');
  try {
    readdirSync(store).filter((d) => d.startsWith('playwright@'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .forEach((d) => candidates.push(join(store, d, 'node_modules', 'playwright', 'index.mjs')));
  } catch { /* no pnpm store */ }
  for (const c of candidates) { tried.push(c); if (existsSync(c)) return { entry: c, tried }; }
  return { entry: null, tried };
}

// GitHub sets its login cookies as session cookies, which Chromium drops when the browser exits,
// so a signed-in profile reads as signed out on its next launch. github-signin.mjs saves them
// here (owner-only); upload-images.mjs adds them back to each run's context.
export const sessionFile = (profile) => `${profile.replace(/\/+$/, '')}.github-session.json`;
