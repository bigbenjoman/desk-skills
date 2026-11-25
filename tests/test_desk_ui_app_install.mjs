// suite: the desk app's build in install.sh (source hash, the swap, the previous build kept, uninstall)
// covers: desk/bin/desk-app.mjs install.sh desk/ui/package.json
// desk-app.mjs install-ui and uninstall, and install.sh's install_desk_ui_app, on a throwaway HOME
// with a stub npm whose build copies the source's src/App.jsx into dist/index.html, and fails when it
// says BREAK. Nothing touches your real ~/.claude, ~/.config/desk or state.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'desk', 'bin', 'desk-app.mjs');
const T = scratch('desk-ui-app-');

const home = join(T, 'home');
const env = { HOME: home, DESK_HOME: join(home, '.claude', 'desk'), DESK_CONFIG_ROOT: join(home, '.config', 'desk'), DESK_PLATFORM: 'darwin',
  PATH: `${join(T, 'bin')}:${process.env.PATH}` };
mkdirSync(join(T, 'bin'), { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(join(T, 'bin', 'npm'), `#!/bin/sh
echo "npm $*" >> "${T}/npm.calls"
case "$1" in
  ci|install) mkdir -p node_modules ;;
  run) grep -q BREAK src/App.jsx && { echo "vite: build failed" >&2; exit 1; }
       mkdir -p dist/assets && cp src/App.jsx dist/index.html && echo asset > dist/assets/app.js ;;
esac
`, { mode: 0o755 });

const calls = () => { try { return readFileSync(join(T, 'npm.calls'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const run = (args, more = {}) => { const r = spawnSync('node', [BIN, ...args], { env: { ...env, ...more }, encoding: 'utf8', timeout: 60000 }); return { code: r.status, out: r.stdout + r.stderr }; };
const UI = join(env.DESK_HOME, 'ui');
const DIST = join(UI, 'dist');
const LOG = join(home, '.desk-autopilot', 'ui', 'desk-ui-build.log');
const served = () => { try { return readFileSync(join(DIST, 'index.html'), 'utf8'); } catch { return null; } };

// The app's source, a copy so the test can change it.
const SRC = join(T, 'ui');
cpSync(join(ROOT, 'desk', 'ui'), SRC, { recursive: true, filter: (p) => !/\/(node_modules|dist)(\/|$)/.test(p) });
const original = readFileSync(join(SRC, 'src', 'App.jsx'), 'utf8');
const edit = (text) => writeFileSync(join(SRC, 'src', 'App.jsx'), text);

t('usage is refused without --src', run(['install-ui']).code, 2);
t('a folder with no package.json is refused', run(['install-ui', '--src', join(T, 'nothing')]).code, 2);

// ---- the first build
const first = run(['install-ui', '--src', SRC]);
t('the first build installs ~/.claude/desk/ui/dist', [first.code, /desk app: built/.test(first.out), served() === original], [0, true, true]);
t('npm installs from the lockfile, then builds', calls().map((c) => c.split(' ').slice(0, 2).join(' ')),
  existsSync(join(SRC, 'package-lock.json')) ? ['npm ci', 'npm run'] : ['npm install', 'npm run']);
t('the build leaves only the build and its stamp beside it', readdirSync(UI).sort(), ['dist', 'source-hash']);
t('the source folder gets no node_modules or dist', [existsSync(join(SRC, 'node_modules')), existsSync(join(SRC, 'dist'))], [false, false]);

// ---- AC1: a source change is built and swapped in
edit(`${original}// changed\n`);
const second = run(['install-ui', '--src', SRC]);
t('AC1 a source change rebuilds the app', [second.code, /desk app: rebuilt/.test(second.out), /once it reloads/.test(second.out), served()?.endsWith('// changed\n')], [0, true, true, true]);

// ---- unchanged source is not rebuilt
const npmBefore = calls().length;
const mtime = statSync(join(DIST, 'index.html')).mtimeMs;
const third = run(['install-ui', '--src', SRC]);
t('unchanged source: not rebuilt', [third.code, /unchanged/.test(third.out), calls().length, statSync(join(DIST, 'index.html')).mtimeMs], [0, true, npmBefore, mtime]);
mkdirSync(join(SRC, 'node_modules', 'x'), { recursive: true });
writeFileSync(join(SRC, 'node_modules', 'x', 'index.js'), '');
mkdirSync(join(SRC, 'dist'), { recursive: true });
writeFileSync(join(SRC, 'dist', 'index.html'), 'a local build');
t('installed modules and a local build are not source', /unchanged/.test(run(['install-ui', '--src', SRC]).out), true);

// ---- AC2: a failed build keeps the previous one in service
edit(`${original}// BREAK\n`);
const broken = run(['install-ui', '--src', SRC]);
t('AC2 a failed build exits 1 and names its log', [broken.code, broken.out.includes('~/.desk-autopilot/ui/desk-ui-build.log'), /previous build is still served/.test(broken.out)], [1, true, true]);
t('AC2 the log holds the build\'s own error', readFileSync(LOG, 'utf8').includes('vite: build failed'), true);
t('AC2 the previous build is still served, as it was', served()?.endsWith('// changed\n'), true);
t('AC2 no half-built folder is left', readdirSync(UI).sort(), ['dist', 'source-hash']);
t('a failed build is tried again on the next install', /failed/.test(run(['install-ui', '--src', SRC]).out), true);

// install.sh's own step, taken from install.sh with stand-ins for its output helpers: a failed build
// is a warning naming the log, and the install goes on.
const sh = readFileSync(join(ROOT, 'install.sh'), 'utf8');
const fn = sh.match(/^install_desk_ui_app\(\) \{\n[\s\S]*?\n\}$/m)?.[0];
t('install_desk_ui_app is found in install.sh', !!fn, true);
t('install.sh builds the app after it installs the server, and before Desk.app', /^install_desk_ui$[\s\S]*^install_desk_ui_app$[\s\S]*^install_desk_app$/m.test(sh), true);
const step = (more = {}) => spawnSync('bash', ['-c', `set -euo pipefail
WARNINGS=0; WROTE=""
ok(){ echo "ok $1"; }; warn(){ echo "WARN $1"; WARNINGS=$((WARNINGS+1)); }; note(){ echo "note $1"; }; wrote(){ WROTE="$WROTE$1"; }
has(){ command -v "$1" >/dev/null 2>&1; }; show_err(){ printf '%s\\n' "$1" | sed 's/^/  | /'; }
${fn}
install_desk_ui_app
echo "went on, warnings=$WARNINGS"`], { env: { ...env, OS: 'mac', DESKDIR: env.DESK_HOME, SRC: T, ...more }, encoding: 'utf8', timeout: 60000 });
// install.sh runs the release's copy and builds from <checkout>/desk/ui.
mkdirSync(join(env.DESK_HOME, 'bin'), { recursive: true });
cpSync(join(ROOT, 'desk', 'bin'), join(env.DESK_HOME, 'bin'), { recursive: true });
mkdirSync(join(T, 'desk'), { recursive: true });
cpSync(SRC, join(T, 'desk', 'ui'), { recursive: true });
const failing = step();
t('AC2 install.sh: a failed build warns with its log and the install goes on',
  [failing.status, /WARN the desk app was not rebuilt/.test(failing.stdout), failing.stdout.includes('desk-ui-build.log'), /went on, warnings=1/.test(failing.stdout)], [0, true, true, true]);
writeFileSync(join(T, 'desk', 'ui', 'src', 'App.jsx'), original);
const fixed = step();
t('AC1 install.sh: the next good build replaces it', [fixed.status, /ok desk app: rebuilt/.test(fixed.stdout), served() === original], [0, true, true]);
t('install.sh: off macOS the step is skipped', /note skipped/.test(step({ OS: 'linux' }).stdout), true);

// ---- uninstall removes the build with Desk.app
writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
const un = spawnSync('bash', [join(ROOT, 'install.sh'), '--uninstall-ui'], { env, encoding: 'utf8', timeout: 60000 });
t('install.sh --uninstall-ui removes the app build', [un.status, existsSync(UI), /desk app: removed its build/.test(un.stdout)], [0, false, true]);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
