// suite: bin main guard (every installed script runs its command through the install's symlinks)
// layer: L2
// covers: desk/bin/*.mjs desk/bin/desk-env.sh skills/*/bin/*.mjs
// install.sh links ~/.claude/desk/bin through current/ to releases/<commit>/bin. Node runs the real
// file, so import.meta.url is the real path while process.argv[1] keeps the linked one: a guard that
// compares them unresolved never fires, and the script exits 0 having printed nothing.
// Scratch directories only.
import { readFileSync, readdirSync, mkdirSync, symlinkSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every script an install links: desk/bin and each skill's bin.
const scripts = [
  ...readdirSync(join(root, 'desk/bin')).filter((f) => f.endsWith('.mjs')).map((f) => `desk/bin/${f}`),
  ...readdirSync(join(root, 'skills')).flatMap((s) => (existsSync(join(root, 'skills', s, 'bin'))
    ? readdirSync(join(root, 'skills', s, 'bin')).filter((f) => f.endsWith('.mjs')).map((f) => `skills/${s}/bin/${f}`) : [])),
];
const guards = scripts.flatMap((f) => readFileSync(join(root, f), 'utf8').split('\n')
  .filter((l) => l.includes('process.argv[1]') && l.includes('import.meta.url')).map((l) => ({ f, l })));
t(`the main-module guards are found (${guards.length})`, guards.length >= 50, true);
const real = (side) => new RegExp(`\\b(realpathSync|real)\\(${side}\\)`);
t('every guard compares real paths on both sides',
  guards.filter(({ l }) => !(real('process\\.argv\\[1\\]').test(l) && real('fileURLToPath\\(import\\.meta\\.url\\)').test(l))).map(({ f }) => f), []);

// The install's layout: bin -> current/bin, current -> releases/<commit>, releases/<commit>/bin -> this checkout's.
const S = scratch('bin-guard-');
mkdirSync(join(S, 'releases/abc'), { recursive: true });
symlinkSync(join(root, 'desk/bin'), join(S, 'releases/abc/bin'));
symlinkSync('releases/abc', join(S, 'current'));
symlinkSync('current/bin', join(S, 'bin'));
const run = (args, env = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...env } });

let r = run([join(S, 'bin/worker-tools.mjs'), 'triage']);
t('worker-tools.mjs through the links prints the triage list', [r.status, r.stdout.trim()], [0, 'Bash,Read,Write']);
r = run([join(S, 'bin/run-by.mjs'), 'offer'], { DESK_PLATFORM: 'win32' });
t('run-by.mjs offer through the links prints its answer', [r.status, JSON.parse(r.stdout || '{}').value], [0, 'session']);

const sh = (body, env = {}) => spawnSync('bash', ['-c', body], { encoding: 'utf8', env: { ...process.env, AUTOPILOT_DEFAULT_TOOLS: '', ...env } });
r = sh(`. "${S}/bin/desk-env.sh" && desk_tool_args triage && printf '%s|' "\${DESK_TOOL_ARGS[@]}"`);
t('desk_tool_args through the links passes the triage list', [r.status, r.stdout], [0, '--tools|Bash,Read,Write|']);

// A tool list that comes back empty is refused, rather than launching a session with no tools at all.
const F = join(S, 'fake');
mkdirSync(F);
writeFileSync(join(F, 'desk-env.sh'), readFileSync(join(root, 'desk/bin/desk-env.sh')));
writeFileSync(join(F, 'worker-tools.mjs'), '');
r = sh(`. "${F}/desk-env.sh" && desk_tool_args worker`);
t('an empty list for worker is refused, and says why', [r.status !== 0, /empty/.test(r.stderr)], [true, true]);
r = sh(`. "${F}/desk-env.sh" && desk_tool_args none && printf '%s|' "\${DESK_TOOL_ARGS[@]}"`);
t('none still passes an empty list', [r.status, r.stdout], [0, '--tools||']);

// The prose facts registry imports desk-env.mjs and the queue's command list: importing it prints
// nothing and runs no script's command.
r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(join(root, 'desk/bin/prose-facts.mjs'))})`], { encoding: 'utf8', cwd: S });
t('importing prose-facts.mjs prints nothing and runs no main', [r.status, r.stdout, r.stderr], [0, '', '']);

rmSync(S, { recursive: true, force: true });
if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
