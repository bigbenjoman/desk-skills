// suite: desk-q supervisor on, off and status (command and s key)
// desk-q's supervisor command against fixture repos under a temporary HOME, DESK_HOME and
// DESK_CONFIG_ROOT, with a fake supervisor.mjs (DESK_SUPERVISOR_MJS) that keeps each repo's agent
// state in a file and a fake platform (DESK_PLATFORM). Nothing touches launchd or your real state.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-q.mjs');
// Real path, so the cwd the fake reports (macOS's /var is /private/var) matches the configured root.
const T = realpathSync(mkdtempSync(join(tmpdir(), 'desk-q-sup-')));
const SUP = join(T, 'sup');
mkdirSync(SUP, { recursive: true });

// The fake: `<repo dir name>.state` holds none, installed or loaded; `<sub>.exit` makes that
// command fail with that code. A failed install leaves the agent installed but not loaded, as a
// failed launchctl bootstrap does. Every call is logged with the repo dir and cwd it ran in.
const FAKE = join(T, 'supervisor.mjs');
writeFileSync(FAKE, `import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
const dir = ${JSON.stringify(SUP)};
const [sub, ...rest] = process.argv.slice(2);
const name = basename(process.env.DESK_REPO_DIR);
const file = join(dir, name + '.state');
const state = existsSync(file) ? readFileSync(file, 'utf8').trim() : 'none';
const everyFile = join(dir, name + '.every');
const every = existsSync(everyFile) ? readFileSync(everyFile, 'utf8').trim() : '180';
appendFileSync(join(dir, 'calls'), sub + ' ' + process.env.DESK_REPO_DIR + ' ' + process.cwd() + ' ' + process.env.DESK_AUTOPILOT_STATE + '\\n');
appendFileSync(join(dir, 'pins'), (process.env.DESK_REPO_OVERRIDE ?? '-') + ' ' + (process.env.GIT_DIR ?? '-') + '\\n');
const fail = join(dir, sub + '.exit');
if (sub === 'install') {
  // As install does, the agent file is written with the interval given, else the default, before it loads.
  const i = rest.indexOf('--interval');
  const n = i < 0 ? '180' : rest[i + 1];
  writeFileSync(everyFile, n);
  if (existsSync(fail)) { writeFileSync(file, 'installed'); console.error('supervisor: launchctl bootstrap failed: Bootstrap failed: 5: Input/output error'); process.exit(Number(readFileSync(fail, 'utf8'))); }
  writeFileSync(file, 'loaded');
  console.log('supervisor: installed com.desk-skills.supervisor.acme__' + name + ': a pass every ' + n + 's and at login for a batch handed over at Stage 4 (queue.mjs set-batch supervised=true); log x');
} else if (sub === 'uninstall') {
  if (existsSync(fail)) { console.error('supervisor: launchctl bootout failed: no such process'); process.exit(Number(readFileSync(fail, 'utf8'))); }
  writeFileSync(file, 'none');
  console.log('supervisor: removed com.desk-skills.supervisor.acme__' + name + ': no further passes run for this repo. A merge driver it started keeps running until it is stopped');
} else if (sub === 'status') {
  console.log('agent: com.desk-skills.supervisor.acme__' + name + ' ' + (state === 'none' ? 'not installed (supervisor.mjs install)' : 'installed (every ' + every + 's), ' + (state === 'loaded' ? 'loaded' : 'not loaded')));
  console.log('batch vp: handed over');
  const log = join(dir, name + '.log');
  if (existsSync(log)) { console.log('log: ' + log + ', last lines:'); for (const l of readFileSync(log, 'utf8').trimEnd().split('\\n')) console.log('  ' + l); }
  process.exitCode = state === 'loaded' ? 0 : 1;
}
`);

const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_SUPERVISOR_MJS: FAKE, DESK_PLATFORM: 'darwin', PATH: process.env.PATH };
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const root = (name) => join(T, 'repos', name);
const cfgPath = (name) => join(env.DESK_CONFIG_ROOT, 'repos', `acme__${name}`, 'config.md');
const qPath = (name) => join(env.DESK_HOME, 'repos', `acme__${name}`, 'queue.json');
const stateOf = (name) => (existsSync(join(SUP, `${name}.state`)) ? readFileSync(join(SUP, `${name}.state`), 'utf8').trim() : 'none');
const setState = (name, s) => writeFileSync(join(SUP, `${name}.state`), s);
const calls = () => (existsSync(join(SUP, 'calls')) ? readFileSync(join(SUP, 'calls'), 'utf8').trim().split('\n') : []);
const clearCalls = () => rmSync(join(SUP, 'calls'), { force: true });

// voicepa and pr-ninja have batches (voicepa's the freshest, so first); forewatt has none. The §3
// merge rows are ask, and voicepa's batch recorded no approvals.
for (const [name, port, beat, batch] of [['voicepa', 3100, 1, 'vp'], ['pr-ninja', 3200, 2, 'pn'], ['forewatt', 3300, null, null]]) {
  mkdirSync(root(name), { recursive: true });
  mkdirSync(dirname(cfgPath(name)), { recursive: true });
  writeFileSync(cfgPath(name), `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${root(name)}\` |\n\n`
    + '## 3. Permissions\n\n| Key | Action | Recommended | Your setting |\n|---|---|---|---|\n| `autopilot-merge` | The merge driver merges | `ask` | `ask` |\n| `pr-merge-green` | Merge a green PR | `ask` | `ask` |\n\n'
    + `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${port}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`2 / 3\` |\n`);
  if (!batch) continue;
  mkdirSync(dirname(qPath(name)), { recursive: true });
  writeFileSync(qPath(name), JSON.stringify({ version: 1, batch, concurrency: 2, approved: { workers: false }, tickets: { [`${batch.toUpperCase()}-1`]: { key: `${batch.toUpperCase()}-1`, state: 'running', stage: '4/9' } } }));
  const state = join(env.HOME, '.desk-autopilot', `acme__${name}`, 'orchestrators');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'q.json'), JSON.stringify({ queue: qPath(name), batch, pid: 1, at: minsAgo(beat) }));
}
const run = (args, extra = {}) => { const r = spawnSync('node', [BIN, ...args], { encoding: 'utf8', env: { ...env, ...extra }, cwd: T }); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }; };
const oneLine = (s) => s.split('\n').length === 1;

// ---- AC1: on, with no supervisor loaded
const on = run(['voicepa', 'supervisor', 'on']);
t('AC1 on installs and loads it', `${on.code} ${stateOf('voicepa')}`, '0 loaded');
t('AC1 and prints one line saying so', oneLine(on.out) && /^voicepa: supervisor on\. It runs a pass every 180s and at login/.test(on.out), true);
t('AC1 install runs in the named repo\'s checkout, with its state', calls().includes(`install ${root('voicepa')} ${root('voicepa')} ${join(env.HOME, '.desk-autopilot', 'acme__voicepa')}`), true);
t('on with it already loaded installs nothing again', `${run(['voicepa', 'supervisor', 'on']).out} ${calls().filter((c) => c.startsWith('install')).length}`, 'voicepa: the supervisor is already on, a pass every 180s. Nothing changed. 1');

// ---- AC2: off, with it loaded
const off = run(['voicepa', 'supervisor', 'off']);
t('AC2 off uninstalls it', `${off.code} ${stateOf('voicepa')}`, '0 none');
t('AC2 one line: no further passes, running workers carry on', oneLine(off.out) && /No further passes run, and running workers carry on to their end/.test(off.out), true);
t('off with it already off says so', run(['voicepa', 'supervisor', 'off']).out, 'voicepa: the supervisor is already off. Nothing changed.');
setState('voicepa', 'installed');
t('off removes an agent installed but not loaded, which would load at login', `${run(['voicepa', 'supervisor', 'off']).code} ${stateOf('voicepa')}`, '0 none');

// ---- AC3: status, for any repo
setState('voicepa', 'loaded');
writeFileSync(join(SUP, 'voicepa.log'), '== 2026-10-24T07:00:00Z pass: exit 0 (ok)\n== 2026-10-24T07:03:00Z skipped: a pass is still running (pid 12)\n');
const st = run(['voicepa', 'supervisor']);
t('AC3 status says installed and loaded, then its last log line', st.out, 'voicepa: the supervisor is on: installed and loaded, a pass every 180s.\nLast log line: == 2026-10-24T07:03:00Z skipped: a pass is still running (pid 12)');
t('AC3 a repo with no batch has a status too', run(['forewatt', 'supervisor']).out, 'forewatt: the supervisor is off: not installed. Turn it on: desk-q forewatt supervisor on.\nNo supervisor log yet.');
setState('pr-ninja', 'installed');
t('AC3 installed but not loaded says so', /^pr-ninja: the supervisor is installed but not loaded, so no passes run\./.test(run(['pr-ninja', 'supervisor']).out), true);
setState('pr-ninja', 'none');
t('anything but on or off is refused', /On, off or its status\?/.test(run(['voicepa', 'supervisor', 'maybe']).err), true);

// ---- AC7: an install that fails
writeFileSync(join(SUP, 'install.exit'), '1');
const bad = run(['forewatt', 'supervisor', 'on']);
t('AC7 a failed install prints its error', bad.code !== 0 && /could not be turned on: launchctl bootstrap failed: Bootstrap failed: 5/.test(bad.err), true);
t('AC7 and the supervisor is as it was: not installed', stateOf('forewatt'), 'none');
// An agent installed but not loaded keeps its own interval, whether the load fails or not.
setState('forewatt', 'installed'); writeFileSync(join(SUP, 'forewatt.every'), '600');
const bad2 = run(['forewatt', 'supervisor', 'on']);
t('AC7 a failed load leaves an installed agent installed, with its interval', `${bad2.code !== 0} ${stateOf('forewatt')} ${readFileSync(join(SUP, 'forewatt.every'), 'utf8')}`, 'true installed 600');
rmSync(join(SUP, 'install.exit'));
t('on keeps an installed agent\'s interval', `${run(['forewatt', 'supervisor', 'on']).out.includes('every 600s')} ${stateOf('forewatt')} ${readFileSync(join(SUP, 'forewatt.every'), 'utf8')}`, 'true loaded 600');
setState('forewatt', 'none'); rmSync(join(SUP, 'forewatt.every'));

// An override that pins the calling repo never reaches the named repo's supervisor.
rmSync(join(SUP, 'pins'), { force: true });
run(['forewatt', 'supervisor'], { DESK_REPO_OVERRIDE: 'acme/voicepa', GIT_DIR: join(T, 'elsewhere', '.git') });
t('the calling repo\'s overrides are not passed on', readFileSync(join(SUP, 'pins'), 'utf8').trim(), '- -');

// ---- AC8: not macOS
clearCalls();
const linux = run(['pr-ninja', 'supervisor', 'on'], { DESK_PLATFORM: 'linux' });
t('AC8 on a computer that is not macOS, one line saying it needs launchd', `${linux.code !== 0} ${linux.err}`, 'true The supervisor needs macOS launchd, so it cannot run on this computer. Nothing changed.');
t('AC8 and nothing changes: supervisor.mjs is never run', `${calls().length} ${stateOf('pr-ninja')}`, '0 none');

// ---- AC9: on changes no §3 row and no batch approval
const cfgBefore = readFileSync(cfgPath('pr-ninja'), 'utf8'), qBefore = readFileSync(qPath('pr-ninja'), 'utf8');
t('AC9 on with the merge rows at ask', run(['pr-ninja', 'supervisor', 'on']).code, 0);
t('AC9 the config is unchanged', readFileSync(cfgPath('pr-ninja'), 'utf8') === cfgBefore, true);
t('AC9 the queue, and its approvals, are unchanged', readFileSync(qPath('pr-ninja'), 'utf8') === qBefore, true);
setState('pr-ninja', 'none');

// ---- the full screen: AC4, AC5, AC6 and AC10, in-process. desk-env reads HOME when first imported.
Object.assign(process.env, env);
const Q = await import(BIN);
const { PassThrough } = await import('node:stream');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const input = new PassThrough();
Object.assign(input, { isTTY: true, setRawMode: () => {} });
const output = { buf: '', columns: 160, rows: 24, write(s) { this.buf += s; }, on() {}, removeListener() {} };
const ui = Q.interactive({ input, output, start: { kind: 'overview', all: false }, exit: () => {}, refreshMs: 600000, probeWith: async () => ({ ran: false }) });
const raw = () => output.buf.split('\x1b[H').at(-1).split('\r\n').map((l) => l.replace(/\x1b\[J$/, '').replace(/\x1b\[K$/, ''));
const frame = () => raw().map((l) => l.replace(ANSI, ''));
const press = async (s) => { input.write(s); await sleep(s === '\x1b' ? 600 : 30); };
const QUESTION = 'Turn off the supervisor for voicepa? Running workers finish.  y / n';
await sleep(30);
t('the key bar names s', frame().some((l) => / s supervisor · /.test(l)), true);

setState('voicepa', 'loaded');
clearCalls();
await press('s');
t('AC4 s on a loaded repo asks inline', frame().at(-1), QUESTION);
await press('q'); await press('x');
t('AC4 nothing changes until it is answered', `${stateOf('voicepa')} ${calls().filter((c) => !c.startsWith('status')).length} ${frame().at(-1)}`, `loaded 0 ${QUESTION}`);
// AC10: the question in the terminal's own text colour, only its keys bold: no colour of desk-q's own.
const fg = (l) => /\x1b\[(3[0-9]|9[0-7]|4[0-9]|10[0-7])(;[0-9;]*)?m/.test(l);
t('AC10 the question sets no text or background colour', fg(raw().at(-1)), false);
await press('n');
t('AC5 n leaves it on and the line goes', `${stateOf('voicepa')} ${frame().includes(QUESTION)}`, 'loaded false');
await press('s'); await press('\x1b');
t('AC5 esc leaves it on and the line goes', `${stateOf('voicepa')} ${frame().includes(QUESTION)}`, 'loaded false');
await press('s'); await press('y');
const said = frame().find((l) => l.startsWith('voicepa: supervisor off.')) ?? '';
t('y turns it off and says so', `${stateOf('voicepa')} ${said !== ''}`, 'none true');
// Found in the stripped frame, read in the raw one: a colour before the text must not hide the line.
const at = frame().findIndex((l) => l.startsWith('voicepa: supervisor off.'));
t('AC10 the result line sets no text or background colour', at >= 0 && !fg(raw()[at]), true);

await press('\x1b[B');
t('pr-ninja is selected', /^› pr-ninja\s/.test(frame().find((l) => l.startsWith('›')) ?? ''), true);
await press('s');
t('AC6 s on a repo with none loaded turns it on with no question', `${stateOf('pr-ninja')} ${frame().some((l) => l.startsWith('Turn off'))}`, 'loaded false');
t('AC6 and says so', frame().some((l) => l.startsWith('pr-ninja: supervisor on.')), true);
process.env.DESK_PLATFORM = 'linux';
await press('s');
t('AC8 s on a computer that is not macOS says it needs launchd', frame().some((l) => l.startsWith('The supervisor needs macOS launchd')), true);
ui.finish(0);

console.log(fails ? `${fails} failed` : 'all desk-q supervisor checks passed');
process.exit(fails ? 1 : 0);
