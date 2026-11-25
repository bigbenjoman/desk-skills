// suite: desk-ui install and uninstall (the token file, the port check and the launchd job)
// layer: L3
// covers: desk/bin/desk-ui.mjs install.sh
// desk-ui.mjs install and install.sh --uninstall-ui on a throwaway HOME with a fake launchctl, which
// starts and stops the server itself on a test-only port. Nothing touches your real launchd,
// ~/.claude, ~/.config/desk or state.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';
import { freePort } from './local-http.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'desk', 'bin', 'desk-ui.mjs');

const answers = (port) => new Promise((resolve) => { const c = connect({ host: '127.0.0.1', port }); c.once('connect', () => { c.destroy(); resolve(true); }); c.once('error', () => resolve(false)); });

const T = scratch('desk-ui-install-');
const PORT = await freePort();
const UID = process.getuid();
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'home', '.claude', 'desk'), DESK_CONFIG_ROOT: join(T, 'home', '.config', 'desk'),
  DESK_PLATFORM: 'darwin', DESK_UI_TEST_PORT: String(PORT), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
mkdirSync(join(T, 'bin'), { recursive: true });
mkdirSync(env.HOME, { recursive: true });
// launchd: `print` answers while loaded, `bootstrap` starts the server, `bootout` stops it, and fails
// (as launchctl does, "No such process") when the job is not loaded.
writeFileSync(join(T, 'bin', 'launchctl'), `#!/bin/sh
echo "$@" >> "${T}/launchctl.calls"
case "$1" in
  print) [ -f "${T}/loaded" ] ;;
  bootstrap) : > "${T}/loaded"; node "${BIN}" serve >> "${T}/server.out" 2>&1 & echo $! > "${T}/server.pid" ;;
  bootout) [ -f "${T}/loaded" ] || exit 3
    [ -f "${T}/server.pid" ] && kill "$(cat "${T}/server.pid")" 2>/dev/null; rm -f "${T}/loaded" "${T}/server.pid"; sleep 0.3 ;;
esac
`, { mode: 0o755 });
process.on('exit', () => { try { process.kill(Number(readFileSync(join(T, 'server.pid'), 'utf8')), 'SIGTERM'); } catch { /* not running */ } });

const calls = () => { try { return readFileSync(join(T, 'launchctl.calls'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const clearCalls = () => writeFileSync(join(T, 'launchctl.calls'), '');
const install = (more = {}) => { const r = spawnSync('node', [BIN, 'install'], { env: { ...env, ...more }, encoding: 'utf8', timeout: 30000 }); return { code: r.status, out: r.stdout + r.stderr }; };
const TOKEN = join(env.DESK_CONFIG_ROOT, 'ui-token');
const PLIST = join(env.HOME, 'Library', 'LaunchAgents', 'com.desk-skills.ui.plist');

// State that must never change: a queue and a batch's state files.
mkdirSync(join(env.DESK_HOME, 'repos', 'acme__widgets'), { recursive: true });
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__widgets', 'queue.json'), '{"version":1,"tickets":{}}');
mkdirSync(join(env.HOME, '.desk-autopilot', 'acme__widgets', 'parks'), { recursive: true });
writeFileSync(join(env.HOME, '.desk-autopilot', 'acme__widgets', 'parks', 'WID-1.json'), '{"question":"which?"}');
const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
const state = () => [join(env.DESK_HOME, 'repos'), join(env.HOME, '.desk-autopilot', 'acme__widgets')].flatMap(walk).sort()
  .map((f) => `${f} ${createHash('sha256').update(readFileSync(f)).digest('hex')}`);

// ---- elsewhere than macOS, nothing is installed
const linux = install({ DESK_PLATFORM: 'linux' });
t('off macOS the install is skipped and touches nothing', [linux.code, /skipped/.test(linux.out), calls().length, existsSync(TOKEN)], [0, true, 0, false]);

// ---- AC8: another process on the port stops the install, naming it
const holder = createServer().listen(PORT, '127.0.0.1');
await new Promise((r) => holder.once('listening', r));
const clash = install();
t('AC8 another listener on the port stops the install', clash.code, 3);
t('AC8 the message names the port', clash.out.includes(`port ${PORT}`) && /never moves to another port/.test(clash.out), true);
t('AC8 the server is never started, here or on another port', [calls().filter((c) => c.startsWith('bootstrap')).length, existsSync(PLIST)], [0, false]);
await new Promise((r) => holder.close(r));
clearCalls();

// ---- AC9: with no token file, the install writes it for you alone and loads a job that answers
rmSync(TOKEN, { force: true }); // the refused install above wrote one
const before = state();
const first = install();
t('AC9 the install succeeds, writing the token', [first.code, first.out.includes('token written')], [0, true]);
t('AC9 the token file exists, readable only by you', [existsSync(TOKEN), existsSync(TOKEN) && (statSync(TOKEN).mode & 0o777).toString(8)], [true, '600']);
t('AC9 the token is 32 random bytes', /^[0-9a-f]{64}$/.test(readFileSync(TOKEN, 'utf8').trim()), true);
t('AC9 the launchd job is loaded from its plist', calls().includes(`bootstrap gui/${UID} ${PLIST}`), true);
t('AC9 and answers on 127.0.0.1', [await answers(PORT), first.out.includes(`answering on http://127.0.0.1:${PORT}`)], [true, true]);
const plist = existsSync(PLIST) ? readFileSync(PLIST, 'utf8') : '';
t('AC9 the job runs desk-ui serve, kept alive by launchd',
  [/<key>Label<\/key>\s*<string>com\.desk-skills\.ui<\/string>/.test(plist), /desk-ui\.mjs<\/string>\s*<string>serve<\/string>/.test(plist), /<key>KeepAlive<\/key>\s*<true\/>/.test(plist)], [true, true, true]);
const token = readFileSync(TOKEN, 'utf8');

// Run again, the server it already runs is not a clash, and the token stays.
clearCalls();
const again = install();
t('a second install reloads its own server', [again.code, calls().filter((c) => /^(bootout|bootstrap) /.test(c)).map((c) => c.split(' ')[0])], [0, ['bootout', 'bootstrap']]);
t('a second install keeps the token', readFileSync(TOKEN, 'utf8'), token);
t('AC9 the install changes no queue or state file', state(), before);

// ---- AC10: install.sh --uninstall-ui unloads the job and removes its plist, and nothing else
clearCalls();
const un = spawnSync('bash', [join(ROOT, 'install.sh'), '--uninstall-ui'], { env, encoding: 'utf8', timeout: 30000 });
t('AC10 install.sh --uninstall-ui succeeds', [un.status, /removed com\.desk-skills\.ui/.test(un.stdout)], [0, true]);
t('AC10 the launchd job is unloaded', calls().includes(`bootout gui/${UID}/com.desk-skills.ui`), true);
t('AC10 its plist is removed', existsSync(PLIST), false);
t('AC10 the server no longer answers', await answers(PORT), false);
t('AC10 no queue or state file changes', state(), before);
t('AC10 the token file stays', readFileSync(TOKEN, 'utf8'), token);
const twice = spawnSync('bash', [join(ROOT, 'install.sh'), '--uninstall-ui'], { env, encoding: 'utf8', timeout: 30000 });
t('uninstalling again says it was not installed', [twice.status, /was not installed/.test(twice.stdout)], [0, true]);

t('install.sh --help lists --uninstall-ui', spawnSync('bash', [join(ROOT, 'install.sh'), '--help'], { env, encoding: 'utf8' }).stdout.includes('--uninstall-ui'), true);

// install.sh's own functions, taken from it and run under its shell options with its output helpers
// stubbed: the install step on macOS, and what --rollback does about the job. DESKDIR's bin is this
// checkout's desk/bin.
const DESKDIR = join(T, 'deskdir');
mkdirSync(DESKDIR, { recursive: true });
symlinkSync(join(ROOT, 'desk', 'bin'), join(DESKDIR, 'bin'));
const shFn = (name, more = {}) => {
  const r = spawnSync('bash', ['-c', `set -euo pipefail
eval "$(sed -n '/^${name}() {$/,/^}$/p' "$1")"
note(){ echo "note: $*"; }; ok(){ echo "ok: $*"; }; warn(){ echo "warn: $*"; }; wrote(){ echo "wrote: $*"; }; show_err(){ echo "err: $*"; }
declare -F ${name} >/dev/null || { echo "no ${name} in install.sh"; exit 9; }
${name}`, 'sh', join(ROOT, 'install.sh')], { env: { ...env, DESKDIR, OS: 'mac', ...more }, encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: r.stdout + r.stderr };
};
clearCalls();
const offMac = shFn('install_desk_ui', { OS: 'linux' });
t('install.sh skips the server off macOS', [offMac.code, /^note: skipped/m.test(offMac.out), calls().length], [0, true, 0]);
const onMac = shFn('install_desk_ui');
t('install.sh loads the server on macOS', [onMac.code, /^ok: desk-ui: com\.desk-skills\.ui loaded and answering/m.test(onMac.out), calls().includes(`bootstrap gui/${UID} ${PLIST}`), existsSync(PLIST)], [0, true, true, true]);
t('and it answers', await answers(PORT), true);
spawnSync(join(T, 'bin', 'launchctl'), ['bootout', `gui/${UID}/com.desk-skills.ui`]); // stop ours; its plist stays
const holder2 = createServer().listen(PORT, '127.0.0.1');
await new Promise((r) => holder2.once('listening', r));
clearCalls();
const shClash = shFn('install_desk_ui');
t('AC8 install.sh warns naming the port and carries on with the rest of the install', [shClash.code, /^warn: the desk-ui server was not started/m.test(shClash.out), shClash.out.includes(`port ${PORT}`)], [0, true, true]);
t('AC8 and never starts the server', calls().filter((c) => c.startsWith('bootstrap')).length, 0);
await new Promise((r) => holder2.close(r));

// --rollback: onto a release with the server the job stays; onto one without it, the job goes.
clearCalls();
const keep = shFn('ui_after_rollback');
t('a rollback onto a release with desk-ui leaves the job', [keep.code, existsSync(PLIST), calls().length], [0, true, 0]);
const OLD = join(T, 'olddesk');
mkdirSync(join(OLD, 'bin'), { recursive: true });
// The job is not loaded here (stopped above, and the refused install left its plist), so the bootout
// fails, as launchctl's does: the plist must still go and the rollback must not fail.
const gone = shFn('ui_after_rollback', { DESKDIR: OLD });
t('a rollback onto a release without desk-ui removes its plist, even with the job not loaded', [gone.code, calls().includes(`bootout gui/${UID}/com.desk-skills.ui`), existsSync(PLIST), /removed com\.desk-skills\.ui/.test(gone.out)], [0, true, false, true]);
t('and changes no queue or state file', state(), before);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
