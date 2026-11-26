// suite: desk-ui first run (GET /api/setup and the Terminal opener, POST /api/terminal)
// layer: L1
// covers: desk/bin/desk-ui.mjs
// The server on a throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT and a free port, with a stub in place
// of osascript, so no Terminal opens and nothing touches your real ~/.claude, ~/.config/desk or ~/studia.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';
import { call as callPort, freePort } from './local-http.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const T = scratch('desk-ui-setup-');
const HOME = join(T, 'home');
Object.assign(process.env, { HOME, DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md') });
mkdirSync(HOME, { recursive: true });
mkdirSync(join(process.env.DESK_CONFIG_ROOT, 'repos'), { recursive: true });
const TOKEN = ['tok', 'd4'.repeat(30)].join('');
writeFileSync(join(process.env.DESK_CONFIG_ROOT, 'ui-token'), `${TOKEN}\n`, { mode: 0o600 });

// ~/studia: two git repos, a folder that is not one, a dot folder and a link to a repo.
const studia = join(HOME, 'studia');
for (const d of ['desk-skills/.git', 'studia-web/.git', 'notes', '.hidden/.git']) mkdirSync(join(studia, d), { recursive: true });
symlinkSync(join(studia, 'studia-web'), join(studia, 'linked'));

const { makeServer, terminalArgs } = await import('../desk/bin/desk-ui.mjs');
const opened = [];
let exitCode = 0;
const PORT = await freePort();
const server = makeServer({ p: PORT, log: () => {}, terminal: async (dir) => { opened.push(dir); return exitCode; } });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const ORIGIN = `http://127.0.0.1:${PORT}`;
const call = (method, path, opts) => callPort(PORT, method, path, opts);
const ex = await call('POST', '/api/auth/exchange', { headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
const signed = { Cookie: String(ex.headers['set-cookie']).split(';')[0], 'X-Desk-Load': JSON.parse(ex.text).loadToken };
const setup = async () => { const r = await call('GET', '/api/setup', { headers: signed }); return r.status === 200 ? JSON.parse(r.text) : r.status; };
const open = (body, { path = '/api/terminal', headers = {} } = {}) => call('POST', path,
  { headers: { ...signed, Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// ---- AC7: desk's commands missing
t('AC7 setup needs the window signed in', (await call('GET', '/api/setup')).status, 401);
t('AC7 with desk\'s commands missing, setup says not installed and lists nothing', await setup(), { installed: false, checkout: null, repos: 0, found: [] });
t('AC10 nothing opens while desk is not installed', [(await open({ folder: 'studia-web' })).status, opened.length], [400, 0]);

mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
writeFileSync(join(HOME, '.local', 'bin', 'desk-env'), '#!/bin/sh\n');
t('AC7 the desk-env command alone is not an install', (await setup()).installed, false);
mkdirSync(join(process.env.DESK_HOME, 'bin'), { recursive: true });
writeFileSync(join(process.env.DESK_HOME, 'bin', 'desk-env.mjs'), '');
writeFileSync(join(process.env.DESK_HOME, 'installed.json'), JSON.stringify({ commit: 'c0ffee', from: join(studia, 'desk-skills') }));

// ---- AC8: installed, no repo configured
const first = await setup();
t('AC8 installed with no repo configured: the git repos under ~/studia, by name', first,
  { installed: true, checkout: '~/studia/desk-skills', repos: 0, found: [{ name: 'desk-skills', path: '~/studia/desk-skills' }, { name: 'studia-web', path: '~/studia/studia-web' }] });

// ---- AC9: Set up on studia-web
const ok = await open({ folder: 'studia-web' });
t('AC9 Set up on studia-web opens Terminal in ~/studia/studia-web', [ok.status, JSON.parse(ok.text), opened], [200, { opened: 'studia-web' }, [join(studia, 'studia-web')]]);
const args = terminalArgs('/Users/ben/studia/studia-web');
const script = args.filter((_, i) => args[i - 1] === '-e');
t('AC9 osascript runs /desk-setup through claude in that folder, the folder its one argument',
  [args.at(-1), script.some((l) => l === 'do script "cd " & quoted form of (item 1 of argv) & " && claude /desk-setup"'), script.includes('tell application "Terminal"')],
  ['/Users/ben/studia/studia-web', true, true]);
t('AC9 the folder never enters the script text', script.some((l) => l.includes('studia-web')), false);
t('AC9 the open is audited', readFileSync(join(HOME, '.desk-autopilot', 'ui', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((e) => [e.route, e.argv, e.exit]),
  [['/api/terminal', ['osascript', '<desk-setup>', '~/studia/studia-web'], 0]]);
exitCode = 1;
t('a Terminal that does not open is a 500', (await open({ folder: 'desk-skills' })).status, 500);
exitCode = 0;
opened.length = 0;

// ---- AC10: anything else is refused and runs nothing
const refused = [
  ['a folder that is not a git repo', { folder: 'notes' }],
  ['a dot folder', { folder: '.hidden' }],
  ['a link to a repo', { folder: 'linked' }],
  ['a parent path', { folder: '..' }],
  ['a path through a repo', { folder: 'studia-web/..' }],
  ['an absolute path', { folder: join(studia, 'studia-web') }],
  ['a folder that does not exist', { folder: 'nope' }],
  ['a folder name with a quote', { folder: 'studia-web" & do shell script "id' }],
  ['an argument beyond the folder', { folder: 'studia-web', args: ['--dangerously-skip-permissions'] }],
  ['a command beside the folder', { folder: 'studia-web', command: 'rm -rf ~' }],
  ['no folder', {}],
  ['a folder that is not a string', { folder: ['studia-web'] }],
  ['an array', ['studia-web']],
];
for (const [what, body] of refused) t(`AC10 ${what} is refused with 400`, (await open(body)).status, 400);
t('AC10 a query beside the folder is refused with 400', (await open({ folder: 'studia-web' }, { path: '/api/terminal?arg=--x' })).status, 400);
t('AC10 a body that is not JSON is refused with 400', (await open('folder=studia-web')).status, 400);
t('AC10 a form post is refused', (await open('folder=studia-web', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
t('AC10 another Origin is refused', (await open({ folder: 'studia-web' }, { headers: { Origin: 'http://evil.example' } })).status, 403);
t('AC10 no session is refused', (await call('POST', '/api/terminal', { headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{"folder":"studia-web"}' })).status, 401);
t('AC10 a GET is refused', (await call('GET', '/api/terminal', { headers: signed })).status, 405);
t('AC10 none of those ran anything', opened, []);

// ---- a configured repo ends the first run
mkdirSync(join(process.env.DESK_CONFIG_ROOT, 'repos', 'acme__widgets'), { recursive: true });
writeFileSync(join(process.env.DESK_CONFIG_ROOT, 'repos', 'acme__widgets', 'config.md'), '## 0. This repo\n');
const after = await setup();
t('with a repo configured, setup counts it and lists no repos', [after.repos, after.found], [1, []]);
t('AC10 with a repo configured, Terminal opens for no folder setup does not list', [(await open({ folder: 'studia-web' })).status, opened], [400, []]);

server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
