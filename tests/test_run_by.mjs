// suite: run-by: who runs a batch (§3b Batches run by), at setup and at Stage 4
// run-by.mjs against a fixture config (DESK_CONFIG), a fake supervisor.mjs (DESK_SUPERVISOR_MJS) that
// keeps the agent's state in a file and fails a command on request, and a fake platform
// (DESK_PLATFORM). Nothing touches launchd or your real state.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'run-by.mjs');
const T = realpathSync(mkdtempSync(join(tmpdir(), 'run-by-')));
const ROOT = join(T, 'repo');
mkdirSync(ROOT, { recursive: true });

// The fake: `state` holds none, installed or loaded, and `every` the agent's interval (180 unless an
// install passed --interval); `<sub>.exit` makes that command fail with that code, and a failed
// install leaves the agent installed but not loaded, as a failed bootstrap does.
const FAKE = join(T, 'supervisor.mjs');
writeFileSync(FAKE, `import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const dir = ${JSON.stringify(T)};
const [sub, ...args] = process.argv.slice(2);
const file = join(dir, 'state');
const state = existsSync(file) ? readFileSync(file, 'utf8').trim() : 'none';
const every = existsSync(join(dir, 'every')) ? readFileSync(join(dir, 'every'), 'utf8').trim() : '180';
appendFileSync(join(dir, 'calls'), [sub, ...args].join(' ') + '\\n');
const fail = join(dir, sub + '.exit');
if (sub === 'install') {
  const i = args.indexOf('--interval');
  writeFileSync(join(dir, 'every'), i < 0 ? '180' : args[i + 1]);
  if (existsSync(fail)) { writeFileSync(file, 'installed'); console.error('supervisor: launchctl bootstrap failed: Bootstrap failed: 5: Input/output error'); process.exit(Number(readFileSync(fail, 'utf8'))); }
  writeFileSync(file, 'loaded');
  console.log('supervisor: installed com.desk-skills.supervisor.acme__repo: a pass every 180s');
} else if (sub === 'uninstall') {
  writeFileSync(file, 'none');
} else if (sub === 'status') {
  console.log('agent: com.desk-skills.supervisor.acme__repo ' + (state === 'none' ? 'not installed' : 'installed (every ' + every + 's), ' + (state === 'loaded' ? 'loaded' : 'not loaded')));
  process.exitCode = state === 'loaded' ? 0 : 1;
}
`);

const CFG = join(T, 'config.md');
const config = (runBy) => writeFileSync(CFG, `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${ROOT}\` |\n\n`
  + '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | `2 / 3` | `2 / 3` |\n'
  + (runBy == null ? '' : `| Batches run by | \`supervisor\` | ${runBy} |\n`));
const setState = (s, every = '180') => { writeFileSync(join(T, 'state'), s); writeFileSync(join(T, 'every'), every); };
const failing = (sub, code) => (code == null ? rmSync(join(T, `${sub}.exit`), { force: true }) : writeFileSync(join(T, `${sub}.exit`), String(code)));
const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8').trim().split('\n').join(' ') : '');
const run = (cmd, platform = 'darwin') => {
  rmSync(join(T, 'calls'), { force: true });
  const p = spawnSync(process.execPath, [BIN, cmd], { cwd: ROOT, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: join(T, 'home'), DESK_CONFIG: CFG, DESK_MACHINE: join(T, 'none.md'), DESK_REPO_DIR: ROOT,
      DESK_SUPERVISOR_MJS: FAKE, DESK_PLATFORM: platform } });
  let out = null;
  try { out = JSON.parse(p.stdout); } catch { out = { raw: p.stdout, err: p.stderr }; }
  return { code: p.status, out, calls: calls() };
};

// AC1: macOS offers the row, supervisor recommended, session the other value.
config('`TODO`');
let r = run('offer');
t('AC1 macOS asks', r.out.ask, true);
t('AC1 supervisor is recommended', r.out.recommended, 'supervisor');
t('AC1 the values are supervisor and session', r.out.options?.join(' '), 'supervisor session');
t('AC1 offering touches no supervisor', r.calls, '');

// AC2: elsewhere it records session and says why in one line.
r = run('offer', 'linux');
t('AC2 not macOS does not ask', r.out.ask, false);
t('AC2 records session', r.out.value, 'session');
t('AC2 says the supervisor needs launchd', /needs macOS launchd/.test(r.out.line) && !r.out.line.includes('\n'), true);

// AC3: setup's ensure after a supervisor answer installs and loads it.
config('`supervisor`');
setState('none'); failing('install', null);
r = run('ensure');
t('AC3 ensure installs', `${r.code} ${r.out.ok} ${r.out.installed}`, '0 true true');
t('AC3 status, install, status', r.calls, 'status install status');
t('AC3 the agent is loaded', readFileSync(join(T, 'state'), 'utf8'), 'loaded');

// AC4: supervisor row, already loaded: handed over, nothing installed.
setState('loaded');
r = run('stage4');
t('AC4 handed to the supervisor', `${r.code} ${r.out.by}`, '0 supervisor');
t('AC4 no install', r.calls, 'status');

// AC5: supervisor row, not installed or not loaded: installed without asking, then handed over.
for (const [s, want] of [['none', 'status install status'], ['installed', 'status install --interval 180 status']]) {
  setState(s);
  r = run('stage4');
  t(`AC5 ${s}: handed to the supervisor`, `${r.code} ${r.out.by} ${r.out.installed}`, '0 supervisor true');
  t(`AC5 ${s}: installed it`, r.calls, want);
}
// An agent installed but not loaded keeps its own interval when it is installed again.
setState('installed', '600');
r = run('stage4');
t('AC5 installed: keeps its interval', `${r.out.by} ${r.calls} ${readFileSync(join(T, 'every'), 'utf8')}`, 'supervisor status install --interval 600 status 600');

// AC6: supervisor row, install fails: the session runs it, with the error and the retry command.
setState('none'); failing('install', 1);
r = run('stage4');
t('AC6 exits 11', r.code, 11);
t('AC6 runs in the session', r.out.by, 'session');
t('AC6 gives the install error', /Bootstrap failed: 5/.test(r.out.error ?? ''), true);
t('AC6 gives the retry command', r.out.retry, `node ~/.claude/desk/bin/supervisor.mjs install (run in ${ROOT})`);
t('AC6 a failed fresh install leaves no agent behind', `${r.calls} ${readFileSync(join(T, 'state'), 'utf8')}`, 'status install uninstall none');
// One installed before the failed install stays installed.
setState('installed');
r = run('stage4');
t('AC6 installed before: still installed', `${r.code} ${r.out.by} ${r.calls} ${readFileSync(join(T, 'state'), 'utf8')}`, '11 session status install --interval 180 installed');
failing('install', null);

// AC7: session row runs in the session, installed or not, without asking the supervisor.
config('`session`');
for (const s of ['loaded', 'none']) {
  setState(s);
  r = run('stage4');
  t(`AC7 ${s}: runs in the session`, `${r.code} ${r.out.by} ${r.out.note}`, '0 session null');
  t(`AC7 ${s}: touches no supervisor`, r.calls, '');
}

// AC8: no row (or TODO) behaves as session and says /desk-setup can set it.
for (const [name, v] of [['no row', null], ['TODO', '`TODO`']]) {
  config(v);
  setState('loaded');
  r = run('stage4');
  t(`AC8 ${name}: runs in the session`, `${r.code} ${r.out.by}`, '0 session');
  t(`AC8 ${name}: says /desk-setup can set it`, /not set.*\/desk-setup can set it/.test(r.out.note ?? ''), true);
  t(`AC8 ${name}: touches no supervisor`, r.calls, '');
}

// An unreadable row is said and read as session; a supervisor row off macOS reads as session too.
config('`launchd`');
r = run('stage4');
t('an unreadable row reads as session', `${r.out.by} ${/want `supervisor` or `session`/.test(r.out.note ?? '')}`, 'session true');
config('`supervisor`');
r = run('stage4', 'linux');
t('supervisor off macOS runs in the session', `${r.code} ${r.out.by} ${/needs macOS launchd/.test(r.out.note ?? '')} ${r.calls}`, '0 session true ');

rmSync(T, { recursive: true, force: true });
if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
