// suite: Desk.app's build in install.sh (source hash, signing, the previous build kept, uninstall)
// covers: desk/bin/desk-app.mjs install.sh
// desk-app.mjs install and uninstall, and install.sh's install_desk_app and --uninstall-ui, on a
// throwaway HOME with a stub npm whose electron-builder writes a tiny app bundle, and stub open and
// launchctl. codesign is the real one on macOS, so the designated requirement is read back with
// codesign -d -r-; elsewhere a stub records what it was asked. Nothing touches your real
// ~/Applications, ~/.claude, ~/.config/desk or state.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'desk', 'bin', 'desk-app.mjs');
const T = scratch('desk-app-');
const REAL_CODESIGN = process.platform === 'darwin' && spawnSync('codesign', ['--help'], { encoding: 'utf8' }).error === undefined;

const home = join(T, 'home');
const env = { HOME: home, DESK_HOME: join(home, '.claude', 'desk'), DESK_CONFIG_ROOT: join(home, '.config', 'desk'), DESK_PLATFORM: 'darwin',
  PATH: `${join(T, 'bin')}:${process.env.PATH}` };
mkdirSync(join(T, 'bin'), { recursive: true });
mkdirSync(home, { recursive: true });
const exe = (name, body) => writeFileSync(join(T, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
// npm ci/install puts an electron-builder in node_modules/.bin that writes dist/mac-arm64/Desk.app, or
// fails when the source says BREAK. The bundle's executable is a copy of /usr/bin/true, so the real
// codesign can sign it.
exe('npm', `echo "npm $*" >> "${T}/npm.calls"
mkdir -p node_modules/.bin
cat > node_modules/.bin/electron-builder <<'EOB'
#!/bin/sh
grep -q BREAK main.mjs && { echo "electron-builder: build failed" >&2; exit 1; }
A=dist/mac-arm64/Desk.app/Contents
mkdir -p "$A/MacOS" "$A/Resources"
cp /usr/bin/true "$A/MacOS/Desk"
cp main.mjs "$A/Resources/main.mjs"
cat > "$A/Info.plist" <<'EOP'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Desk</string><key>CFBundleIdentifier</key><string>com.desk-skills.desk</string><key>CFBundleName</key><string>Desk</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
EOP
EOB
chmod +x node_modules/.bin/electron-builder`);
exe('open', `echo "$*" >> "${T}/open.calls"`);
if (!REAL_CODESIGN) {
  // Records each call; -d -r- prints the requirement the last signing gave the app.
  exe('codesign', `echo "$*" >> "${T}/codesign.calls"
case "$1" in -d) r=$(grep -- '--identifier' "${T}/codesign.calls" | tail -1 | sed 's/.*--requirements =//; s/ [^ ]*$//'); echo "$r" ;; esac`);
}
if (process.platform !== 'darwin') exe('ditto', 'cp -R "$1" "$2"');

const lines = (f) => { try { return readFileSync(join(T, f), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const run = (args, more = {}) => { const r = spawnSync('node', [BIN, ...args], { env: { ...env, ...more }, encoding: 'utf8', timeout: 60000 }); return { code: r.status, out: r.stdout + r.stderr }; };
const APP = join(home, 'Applications', 'Desk.app');
const LOG = join(home, '.desk-autopilot', 'ui', 'desk-app-build.log');
const requirement = () => (REAL_CODESIGN
  ? spawnSync('codesign', ['-d', '-r-', APP], { encoding: 'utf8' }).stdout.trim()
  : spawnSync(join(T, 'bin', 'codesign'), ['-d', '-r-', APP], { encoding: 'utf8' }).stdout.trim());
const builtFrom = () => { try { return readFileSync(join(APP, 'Contents', 'Resources', 'main.mjs'), 'utf8'); } catch { return null; } };

// The shell source, a copy so the test can change it.
const SRC = join(T, 'shell');
cpSync(join(ROOT, 'desk', 'shell'), SRC, { recursive: true });
const edit = (text) => writeFileSync(join(SRC, 'main.mjs'), text);

// State that must never change: a queue and a batch's park.
mkdirSync(join(env.DESK_HOME, 'repos', 'acme__widgets'), { recursive: true });
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__widgets', 'queue.json'), '{"version":1,"tickets":{}}');
mkdirSync(join(home, '.desk-autopilot', 'acme__widgets', 'parks'), { recursive: true });
writeFileSync(join(home, '.desk-autopilot', 'acme__widgets', 'parks', 'WID-1.json'), '{"question":"which?"}');
const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
const state = () => [join(env.DESK_HOME, 'repos'), join(home, '.desk-autopilot', 'acme__widgets')].flatMap(walk).sort()
  .map((f) => `${f} ${createHash('sha256').update(readFileSync(f)).digest('hex')}`);
const stateBefore = state();

// ---- elsewhere than macOS, nothing is built
const linux = run(['install', '--src', SRC], { DESK_PLATFORM: 'linux' });
t('off macOS the build is skipped', [linux.code, /skipped/.test(linux.out), lines('npm.calls').length, existsSync(APP)], [0, true, 0, false]);
t('usage is refused without --src', run(['install']).code, 2);

// ---- AC1: the first build installs Desk.app and opens it
const first = run(['install', '--src', SRC]);
t('the first build installs ~/Applications/Desk.app', [first.code, existsSync(join(APP, 'Contents', 'Info.plist')), /built and opened/.test(first.out)], [0, true, true]);
t('the first build opens Desk.app, once', lines('open.calls'), [APP]);
t('npm installs from the shell\'s package', lines('npm.calls').length, 1);
t('the build leaves no scratch app beside it', readdirSync(join(home, 'Applications')).sort(), ['Desk.app']);

// ---- AC6: the same identifier and requirement across rebuilds
const req1 = requirement();
t('the app carries a designated requirement on its fixed identifier', req1.includes('designated => identifier "com.desk-skills.desk"'), true);
if (REAL_CODESIGN) t('the signature verifies', spawnSync('codesign', ['--verify', '--deep', '--strict', APP]).status, 0);
const original = readFileSync(join(SRC, 'main.mjs'), 'utf8');
edit(`${original}// changed\n`);
const second = run(['install', '--src', SRC]);
t('a source change rebuilds Desk.app', [second.code, /rebuilt/.test(second.out), builtFrom()?.endsWith('// changed\n')], [0, true, true]);
t('a rebuild does not open Desk.app again', lines('open.calls').length, 1);
t('the rebuild has the same designated requirement', requirement(), req1);
t('the rebuild has the same bundle identifier', /<string>com\.desk-skills\.desk<\/string>/.test(readFileSync(join(APP, 'Contents', 'Info.plist'), 'utf8')), true);

// ---- AC7: unchanged source is not rebuilt
const mtime = statSync(join(APP, 'Contents', 'Info.plist')).mtimeMs;
const npmBefore = lines('npm.calls').length;
const third = run(['install', '--src', SRC]);
t('unchanged source: not rebuilt', [third.code, /unchanged/.test(third.out), lines('npm.calls').length, statSync(join(APP, 'Contents', 'Info.plist')).mtimeMs], [0, true, npmBefore, mtime]);
writeFileSync(join(SRC, '.DS_Store'), 'finder');
mkdirSync(join(SRC, 'node_modules', 'x'), { recursive: true });
writeFileSync(join(SRC, 'node_modules', 'x', 'index.js'), '');
t('installed modules and Finder files are not source', /unchanged/.test(run(['install', '--src', SRC]).out), true);

// ---- AC8: a failed build keeps the previous Desk.app
edit(`${original}// BREAK\n`);
const broken = run(['install', '--src', SRC]);
t('a failed build exits 1 and names its log', [broken.code, broken.out.includes('~/.desk-autopilot/ui/desk-app-build.log'), /previous Desk\.app is still in place/.test(broken.out)], [1, true, true]);
t('the log holds the build\'s own error', readFileSync(LOG, 'utf8').includes('electron-builder: build failed'), true);
t('the previous Desk.app stays, as it was', [builtFrom()?.endsWith('// changed\n'), requirement()], [true, req1]);
t('a failed build is tried again on the next install', /failed/.test(run(['install', '--src', SRC]).out), true);

// install.sh's own step, taken from install.sh with stand-ins for its output helpers: a failed build
// is a warning naming the log, and the install goes on.
const sh = readFileSync(join(ROOT, 'install.sh'), 'utf8');
const fn = sh.match(/^install_desk_app\(\) \{\n[\s\S]*?\n\}$/m)?.[0];
t('install_desk_app is found in install.sh', !!fn, true);
const step = (more = {}) => spawnSync('bash', ['-c', `set -euo pipefail
WARNINGS=0; WROTE=""
ok(){ echo "ok $1"; }; warn(){ echo "WARN $1"; WARNINGS=$((WARNINGS+1)); }; note(){ echo "note $1"; }; wrote(){ WROTE="$WROTE$1"; }
has(){ command -v "$1" >/dev/null 2>&1; }; show_err(){ printf '%s\\n' "$1" | sed 's/^/  | /'; }
${fn}
install_desk_app
echo "went on, warnings=$WARNINGS"`], { env: { ...env, OS: 'mac', DESKDIR: env.DESK_HOME, SRC: T, ...more }, encoding: 'utf8', timeout: 60000 });
// install.sh runs the release's copy and builds from <checkout>/desk/shell.
mkdirSync(join(env.DESK_HOME, 'bin'), { recursive: true });
cpSync(join(ROOT, 'desk', 'bin'), join(env.DESK_HOME, 'bin'), { recursive: true });
mkdirSync(join(T, 'desk'), { recursive: true });
cpSync(SRC, join(T, 'desk', 'shell'), { recursive: true });
const failing = step();
t('install.sh: a failed build warns with its log and the install goes on',
  [failing.status, /WARN Desk\.app was not rebuilt/.test(failing.stdout), failing.stdout.includes('desk-app-build.log'), /went on, warnings=1/.test(failing.stdout)], [0, true, true, true]);
writeFileSync(join(T, 'desk', 'shell', 'main.mjs'), original);
const fixed = step();
t('install.sh: the next good build replaces it', [fixed.status, /ok Desk\.app: rebuilt/.test(fixed.stdout), builtFrom() === original], [0, true, true]);
t('install.sh: off macOS the step is skipped', /note skipped/.test(step({ OS: 'linux' }).stdout), true);

// ---- AC9: uninstall removes Desk.app, and no queue or state file changes
exe('launchctl', 'exit 3');
const un = spawnSync('bash', [join(ROOT, 'install.sh'), '--uninstall-ui'], { env, encoding: 'utf8', timeout: 60000 });
t('install.sh --uninstall-ui removes Desk.app and its build cache', [un.status, existsSync(APP), existsSync(join(env.DESK_HOME, 'shell')), /removed .*Desk\.app/.test(un.stdout)], [0, false, false, true]);
t('no queue or state file changed', state(), stateBefore);
t('uninstalling again says it was not installed', /was not installed/.test(run(['uninstall']).out), true);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
