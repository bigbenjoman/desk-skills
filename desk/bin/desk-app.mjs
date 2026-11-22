#!/usr/bin/env node
// Desk.app: builds the Electron shell (desk/shell) into ~/Applications/Desk.app, on macOS only.
//   node desk-app.mjs install --src <desk/shell>   build it when the shell's source or the server's paths
//                                                  (DESK_CONFIG_ROOT, DESK_HOME) changed since the last
//                                                  build, or Desk.app is missing; opens it the
//                                                  first time. A build that fails leaves the previous
//                                                  Desk.app in place, names its log and exits 1
//   node desk-app.mjs uninstall                    remove Desk.app and its build cache; nothing else
//
// Every build is ad-hoc signed with the fixed identifier com.desk-skills.desk and a designated
// requirement naming only that identifier, so a rebuild meets the requirement macOS recorded when it
// granted a permission, and the permission is kept.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { platform } from './run-by.mjs';

export const APP_ID = 'com.desk-skills.desk';
export const REQUIREMENT = `designated => identifier "${APP_ID}"`;
const SKIP = new Set(['node_modules', 'dist', '.DS_Store']);

const appsDir = () => join(E.HOME, 'Applications');
export const appPath = () => join(appsDir(), 'Desk.app');
const cacheDir = () => join(E.deskHome(), 'shell');
const stampFile = () => join(cacheDir(), 'source-hash');
export const logFile = () => join(E.HOME, '.desk-autopilot', 'ui', 'desk-app-build.log');
const tilde = (p) => p.replace(E.HOME, '~');

function files(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((e) => !SKIP.has(e.name))
    .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), root) : e.isFile() ? [relative(root, join(dir, e.name))] : []))
    .sort();
}
// The shell's source as one hash: each file's path and bytes, build output and installed modules aside.
export function sourceHash(src) {
  const h = createHash('sha256');
  for (const f of files(src)) h.update(`${f}\0`).update(readFileSync(join(src, f))).update('\0');
  return h.digest('hex');
}
// The config root and desk home the server was installed with, written into the bundle: Finder and the
// Dock start Desk.app without install.sh's environment, so it cannot find the token file by itself.
export const deskPaths = () => ({ configRoot: E.deskConfigRoot(), deskHome: E.deskHome() });
// What a build is made from: the source, and the paths written into it.
const buildKey = (src, paths) => createHash('sha256').update(`${sourceHash(src)}\0${JSON.stringify(paths)}`).digest('hex');
const stamp = () => { try { return readFileSync(stampFile(), 'utf8').trim(); } catch { return null; } };

function step(log, cmd, args, cwd) {
  appendFileSync(log, `\n$ ${cmd} ${args.join(' ')}\n`);
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  appendFileSync(log, `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `${r.error.message}\n` : ''}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ''} failed`);
  return r.stdout ?? '';
}
const built = (dist) => (existsSync(dist) ? readdirSync(dist).filter((d) => /^mac/.test(d)).map((d) => join(dist, d, 'Desk.app')).find((p) => existsSync(p)) : null);

// Builds into the cache, signs, then swaps the new app in: until the swap the previous one stays.
function build(src, paths, log) {
  const work = join(cacheDir(), 'build');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  for (const f of files(src)) { mkdirSync(join(work, f, '..'), { recursive: true }); cpSync(join(src, f), join(work, f)); }
  writeFileSync(join(work, 'desk-paths.json'), `${JSON.stringify(paths)}\n`);
  step(log, 'npm', existsSync(join(work, 'package-lock.json')) ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'], work);
  step(log, join(work, 'node_modules', '.bin', 'electron-builder'), ['--mac', '--dir'], work);
  const app = built(join(work, 'dist'));
  if (!app) throw new Error('electron-builder wrote no Desk.app');
  step(log, 'codesign', ['--force', '--deep', '--sign', '-', app], work);
  step(log, 'codesign', ['--force', '--sign', '-', '--identifier', APP_ID, '--requirements', `=${REQUIREMENT}`, app], work);
  step(log, 'codesign', ['--verify', '--deep', '--strict', app], work);
  mkdirSync(appsDir(), { recursive: true });
  const next = join(appsDir(), '.Desk.app.new'), old = join(appsDir(), '.Desk.app.old');
  rmSync(next, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  step(log, 'ditto', [app, next], work);
  if (existsSync(appPath())) renameSync(appPath(), old);
  renameSync(next, appPath());
  rmSync(old, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

export function install(src) {
  if (platform() !== 'darwin') { console.log('Desk.app: skipped: Desk.app is built on macOS only'); return 0; }
  if (!src || !existsSync(join(src, 'package.json'))) { console.error(`Desk.app: no shell source at ${src ?? '(none given)'}`); return 2; }
  const paths = deskPaths();
  const hash = buildKey(src, paths);
  const had = existsSync(appPath());
  if (had && stamp() === hash) { console.log(`Desk.app: unchanged since its last build (${tilde(appPath())})`); return 0; }
  mkdirSync(join(logFile(), '..'), { recursive: true });
  writeFileSync(logFile(), `${new Date().toISOString()} building Desk.app from ${src}\n`);
  try {
    build(src, paths, logFile());
  } catch (e) {
    rmSync(join(cacheDir(), 'build'), { recursive: true, force: true });
    console.error(`Desk.app: the build failed (${e.message}); ${had ? 'the previous Desk.app is still in place' : 'no Desk.app was installed'}. Build log: ${tilde(logFile())}`);
    return 1;
  }
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(stampFile(), `${hash}\n`);
  if (!had) spawnSync('open', [appPath()], { stdio: 'ignore' });
  console.log(`Desk.app: ${had ? 'rebuilt' : 'built and opened'}: ${tilde(appPath())} (${APP_ID}, ad-hoc signed)`);
  return 0;
}

export function uninstall() {
  const had = existsSync(appPath());
  rmSync(appPath(), { recursive: true, force: true });
  rmSync(cacheDir(), { recursive: true, force: true });
  console.log(had ? `Desk.app: removed ${tilde(appPath())}` : 'Desk.app: was not installed');
  return 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const [cmd, flag, src] = process.argv.slice(2);
  if (cmd === 'install' && flag === '--src' && src) process.exit(install(src));
  else if (cmd === 'uninstall' && flag === undefined) process.exit(uninstall());
  else { console.error('usage: desk-app.mjs install --src <desk/shell> | uninstall'); process.exit(2); }
}
