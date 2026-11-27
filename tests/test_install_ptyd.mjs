// suite: desk-ptyd install and uninstall (node-pty from the lockfile, a failed build, the launchd job)
// layer: L3
// covers: desk/bin/desk-ptyd.mjs install.sh
// desk-ptyd.mjs install, install.sh's install_desk_ptyd and install.sh --uninstall-ui on a throwaway
// HOME with a fake launchctl and a fake npm: `npm ci` writes a stand-in node-pty, or fails as a native
// build does where FAKE_NPM_FAIL is set. Nothing touches your real launchd, ~/.claude or state.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PTYD = join(ROOT, 'desk', 'bin', 'desk-ptyd.mjs');

const T = scratch('desk-ptyd-install-');
const UID = process.getuid();
const H = join(T, 'home');
const DH = join(H, '.claude', 'desk');
const env = { HOME: H, DESK_HOME: DH, DESK_CONFIG_ROOT: join(H, '.config', 'desk'), DESK_PLATFORM: 'darwin', PATH: `${join(T, 'bin')}:${process.env.PATH}` };
mkdirSync(join(T, 'bin'), { recursive: true });
mkdirSync(H, { recursive: true });
// launchd: `print` answers while loaded, `bootstrap` loads, `bootout` unloads and fails when not loaded.
writeFileSync(join(T, 'bin', 'launchctl'), `#!/bin/sh
echo "$@" >> "${T}/launchctl.calls"
case "$1" in
  print) [ -f "${T}/loaded" ] ;;
  bootstrap) : > "${T}/loaded" ;;
  bootout) [ -f "${T}/loaded" ] || exit 3; rm -f "${T}/loaded" ;;
esac
`, { mode: 0o755 });
// npm ci: a stand-in node-pty in its folder, or a native build that fails.
writeFileSync(join(T, 'bin', 'npm'), `#!/bin/sh
echo "npm $*" >> "${T}/npm.calls"
[ "$1" = ci ] || exit 1
if [ -n "$FAKE_NPM_FAIL" ]; then echo "gyp ERR! build error" >&2; exit 1; fi
mkdir -p node_modules/node-pty
echo '{"name":"node-pty","main":"index.js"}' > node_modules/node-pty/package.json
echo 'exports.spawn = () => { throw new Error("stub"); };' > node_modules/node-pty/index.js
`, { mode: 0o755 });

const read = (f) => { try { return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const calls = () => read(join(T, 'launchctl.calls'));
const clear = () => { writeFileSync(join(T, 'launchctl.calls'), ''); writeFileSync(join(T, 'npm.calls'), ''); };
const PLIST = join(H, 'Library', 'LaunchAgents', 'com.desk-skills.ptyd.plist');
const PTYDIR = join(DH, 'ptyd');
const SRC = join(ROOT, 'desk', 'ptyd');

// install.sh's own function, taken from it and run under its shell options with its helpers stubbed.
// DESKDIR's bin is this checkout's desk/bin.
const DESKDIR = join(T, 'deskdir');
mkdirSync(DESKDIR, { recursive: true });
symlinkSync(join(ROOT, 'desk', 'bin'), join(DESKDIR, 'bin'));
const shFn = (name, more = {}) => {
  const r = spawnSync('bash', ['-c', `set -euo pipefail
eval "$(sed -n '/^${name}() {$/,/^}$/p' "$1")"
note(){ echo "note: $*"; }; ok(){ echo "ok: $*"; }; warn(){ echo "warn: $*"; }; wrote(){ echo "wrote: $*"; }; show_err(){ echo "err: $*"; }
has(){ command -v "$1" >/dev/null 2>&1; }
declare -F ${name} >/dev/null || { echo "no ${name} in install.sh"; exit 9; }
${name}`, 'sh', join(ROOT, 'install.sh')], { env: { ...env, DESKDIR: DH, SRC: ROOT, OS: 'mac', ...more }, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout + r.stderr };
};
// DESKDIR for install_desk_ptyd is DESK_HOME, so the build lands where the daemon loads it from.
mkdirSync(DH, { recursive: true });
symlinkSync(join(ROOT, 'desk', 'bin'), join(DH, 'bin'));

// ---- off macOS, nothing is installed
clear();
const linux = shFn('install_desk_ptyd', { OS: 'linux' });
t('off macOS install.sh skips the daemon', [linux.code, /^note: skipped/m.test(linux.out), calls().length, read(join(T, 'npm.calls')).length], [0, true, 0, 0]);

// ---- AC5: node-pty's native module fails to build: a warning, exit 0, terminals unavailable
clear();
const failed = shFn('install_desk_ptyd', { FAKE_NPM_FAIL: '1' });
t('AC5 install.sh carries on: its step exits 0', failed.code, 0);
t('AC5 with a warning that terminals are unavailable and the rest of Desk works', /^warn: Desk's terminals are unavailable; the rest of Desk works/m.test(failed.out), true);
t('AC5 the warning names the build log', failed.out.includes('ptyd-build.log'), true);
t('AC5 npm ci ran on the lockfile', read(join(T, 'npm.calls')), ['npm ci --no-audit --no-fund']);
t('AC5 no job is loaded and no plist written', [calls().filter((c) => c.startsWith('bootstrap')).length, existsSync(PLIST), existsSync(PTYDIR)], [0, false, false]);
t('AC5 the build log holds the build error', readFileSync(join(H, '.desk-autopilot', 'ui', 'ptyd-build.log'), 'utf8').includes('gyp ERR! build error'), true);
const serve = spawnSync('node', [PTYD, 'serve'], { env, encoding: 'utf8', timeout: 10000 });
t('AC5 the daemon, started anyway, exits saying terminals are unavailable', [serve.status, /terminals are unavailable/.test(serve.stderr)], [4, true]);
const noNpm = shFn('install_desk_ptyd', { PATH: '/usr/bin:/bin' });
t('with no npm install.sh warns and carries on', [noNpm.code, /^warn: Desk's terminals are unavailable: npm is not on PATH/m.test(noNpm.out)], [0, true]);

// ---- a build that works loads the job; the same lockfile again changes nothing
clear();
const good = shFn('install_desk_ptyd');
t('install.sh installs node-pty and loads the job', [good.code, /^ok: desk-ptyd: com\.desk-skills\.ptyd loaded/m.test(good.out), calls().includes(`bootstrap gui/${UID} ${PLIST}`)], [0, true, true]);
t('node-pty lands in ~/.claude/desk/ptyd, stamped', [existsSync(join(PTYDIR, 'node_modules', 'node-pty', 'index.js')), existsSync(join(PTYDIR, 'source-hash'))], [true, true]);
const plist = existsSync(PLIST) ? readFileSync(PLIST, 'utf8') : '';
t('the job runs desk-ptyd serve, kept alive by launchd',
  [/<key>Label<\/key>\s*<string>com\.desk-skills\.ptyd<\/string>/.test(plist), /desk-ptyd\.mjs<\/string>\s*<string>serve<\/string>/.test(plist), /<key>KeepAlive<\/key>\s*<true\/>/.test(plist)], [true, true, true]);
clear();
const again = shFn('install_desk_ptyd');
t('again: no rebuild, and the running daemon (and its terminals) is not restarted',
  [again.code, /already running/.test(again.out), read(join(T, 'npm.calls')).length, calls().filter((c) => /^(bootout|bootstrap) /.test(c)).length], [0, true, 0, 0]);

// A changed lockfile whose build fails keeps the previous node-pty and the running job.
const SRC2 = join(T, 'src2');
mkdirSync(SRC2, { recursive: true });
writeFileSync(join(SRC2, 'package.json'), readFileSync(join(SRC, 'package.json'), 'utf8').replace('"private": true', '"private": true, "version": "0.0.1"'));
writeFileSync(join(SRC2, 'package-lock.json'), readFileSync(join(SRC, 'package-lock.json')));
clear();
const keep = spawnSync('node', [PTYD, 'install', '--src', SRC2], { env: { ...env, FAKE_NPM_FAIL: '1' }, encoding: 'utf8', timeout: 60000 });
t('a failed rebuild keeps the previous node-pty and says so', [keep.status, /previous install is still in use/.test(keep.stderr), existsSync(join(PTYDIR, 'node_modules', 'node-pty', 'index.js'))], [1, true, true]);
t('and leaves the job running', [existsSync(join(T, 'loaded')), calls().filter((c) => c.startsWith('bootout')).length], [true, 0]);

// ---- AC6: install.sh --uninstall-ui unloads the job and removes its plist
clear();
const un = spawnSync('bash', [join(ROOT, 'install.sh'), '--uninstall-ui'], { env, encoding: 'utf8', timeout: 60000 });
t('AC6 install.sh --uninstall-ui succeeds', [un.status, /removed com\.desk-skills\.ptyd/.test(un.stdout)], [0, true]);
t('AC6 its launchd job is unloaded', calls().includes(`bootout gui/${UID}/com.desk-skills.ptyd`), true);
t('AC6 its plist is removed, and node-pty with it', [existsSync(PLIST), existsSync(PTYDIR)], [false, false]);
const twice = spawnSync('bash', [join(ROOT, 'install.sh'), '--uninstall-ui'], { env, encoding: 'utf8', timeout: 60000 });
t('uninstalling again says it was not installed', [twice.status, /com\.desk-skills\.ptyd was not installed/.test(twice.stdout)], [0, true]);

// ---- --rollback onto a release without the daemon removes its job
writeFileSync(PLIST, plist);
clear();
const kept = shFn('ui_after_rollback', { DESKDIR: DESKDIR });
t('a rollback onto a release with desk-ptyd leaves its job', [kept.code, existsSync(PLIST)], [0, true]);
const OLD = join(T, 'olddesk');
mkdirSync(join(OLD, 'bin'), { recursive: true });
writeFileSync(join(OLD, 'bin', 'desk-ui.mjs'), '');
const gone = shFn('ui_after_rollback', { DESKDIR: OLD });
t('a rollback onto a release without desk-ptyd removes its plist', [gone.code, calls().includes(`bootout gui/${UID}/com.desk-skills.ptyd`), existsSync(PLIST), /removed com\.desk-skills\.ptyd/.test(gone.out)], [0, true, false, true]);

t('install.sh --help says --uninstall-ui removes the pty daemon', /--uninstall-ui stops the desk app's server and its pty daemon/.test(spawnSync('bash', [join(ROOT, 'install.sh'), '--help'], { env, encoding: 'utf8' }).stdout), true);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
