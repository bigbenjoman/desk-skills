// suite: desk-ptyd, the pty daemon that hosts Desk's terminals (open, attach, a server restart, refusals, the socket)
// layer: L2
// covers: desk/bin/desk-ptyd.mjs desk/bin/desk-ui-terminals.mjs desk/bin/desk-ui.mjs
// The daemon runs as its own process (`desk-ptyd.mjs serve`) on a throwaway HOME, DESK_HOME and
// DESK_CONFIG_ROOT, with a stand-in node-pty in DESK_HOME/ptyd (child_process pipes in place of a pty)
// and a stub `claude` first on PATH that records its argv, login folder and cwd, echoes what it reads
// and floods 300 KB on `flood`. desk-ui's server is made in this process, twice, to restart it.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)?.slice(0, 300)}${ok ? '' : ` (want ${JSON.stringify(want)?.slice(0, 300)})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const until = async (ok, ms = 8000) => { for (let i = 0; i < ms / 25 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 25)); return !!(await ok()); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const T = scratch('desk-ptyd-');
const H = join(T, 'home');
const CFG = join(T, 'config');
const DH = join(T, 'deskhome');
const STUBS = join(T, 'bin');
// A socket path holds 104 bytes at most and run.sh's TMPDIR is deeper than that, so the socket is
// named relative to the scratch root (DESK_PTYD_TEST_SOCKET, read only under a test HOME), where the
// daemon and this process both run. Its folder starts open to everyone: the daemon must close it.
process.chdir(T);
const SOCKDIR = join(T, 's');
const SOCK = 's/ptyd.sock';
const SOCK_AT = join(SOCKDIR, 'ptyd.sock');
const PORT = await freePort();
const TOKEN = `tok${'e5'.repeat(30)}`;

for (const k of ['CLAUDE_CONFIG_DIR', 'DESK_SUBSCRIPTION', 'DESK_AUTOPILOT_WORKER', 'DESK_CONFIG', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_BATCH', 'DESK_STATE', 'DESK_QUEUE', 'DESK_AUTOPILOT_STATE']) delete process.env[k];
Object.assign(process.env, { HOME: H, DESK_HOME: DH, DESK_CONFIG_ROOT: CFG, DESK_MACHINE: join(T, 'machine.md'), DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'),
  DESK_UI_TEST_PORT: String(PORT), DESK_UI_STUB_DIR: T, DESK_PTYD_TEST_SOCKET: SOCK, ANTHROPIC_API_KEY: 'sk-from-the-daemon', PATH: `${STUBS}:${process.env.PATH}` });
mkdirSync(CFG, { recursive: true });
mkdirSync(SOCKDIR, { mode: 0o755 });
chmodSync(SOCKDIR, 0o755);
writeFileSync(join(CFG, 'ui-token'), `${TOKEN}\n`, { mode: 0o600 });
writeFileSync(process.env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `30 / 30` | x |\n');

// Claude folders, each signed in to its account; studia-web's subscription is login-2's.
const account = (dir, email, json = join(dir, '.claude.json')) => { mkdirSync(dir, { recursive: true }); writeFileSync(json, JSON.stringify({ oauthAccount: { emailAddress: email, planDisplayName: 'Max' } })); };
const OPS = join(H, '.claude-logins', 'login-2');
account(join(H, '.claude'), 'ben@example.com', join(H, '.claude.json'));
account(OPS, 'ops@studia.example');
writeFileSync(process.env.DESK_SUBSCRIPTIONS, '| Tool | Name | Folder | Rule |\n|---|---|---|---|\n'
  + '| `claude` | `default` | `~/.claude` | `default` |\n| `claude` | `login-2` | `~/.claude-logins/login-2` | `unused` |\n');
// The desk skills installed: desk-ticket only.
mkdirSync(join(H, '.claude', 'skills', 'desk-ticket'), { recursive: true });
writeFileSync(join(H, '.claude', 'skills', 'desk-ticket', 'SKILL.md'), '---\nname: desk-ticket\n---\n');

const ROOT = join(T, 'checkouts', 'acme__studia-web');
const TREE = join(`${ROOT}-worktrees`, 'SV-3880');
mkdirSync(ROOT, { recursive: true });
mkdirSync(TREE, { recursive: true });
mkdirSync(join(CFG, 'repos', 'acme__studia-web'), { recursive: true });
writeFileSync(join(CFG, 'repos', 'acme__studia-web', 'config.md'), `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${ROOT}\` |\n\n`
  + '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `3700` |\n| Autopilot worker concurrency | `30 / 30` | `30 / 30` |\n'
  + '| Subscription | `default` | `ops@studia.example` |\n');
mkdirSync(join(DH, 'repos', 'acme__studia-web'), { recursive: true });
writeFileSync(join(DH, 'repos', 'acme__studia-web', 'queue.json'), JSON.stringify({ version: 1, batch: 'w', concurrency: 30,
  tickets: { 'SV-3880': { key: 'SV-3880', state: 'queued' }, 'SV-3881': { key: 'SV-3881', state: 'running' } } }));

// ---- the stub claude and the stand-in node-pty
mkdirSync(STUBS, { recursive: true });
writeFileSync(join(STUBS, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
const dir = process.env.DESK_UI_STUB_DIR;
fs.appendFileSync(dir + '/starts.jsonl', JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  apiKey: process.env.ANTHROPIC_API_KEY ?? null, repoDir: process.env.DESK_REPO_DIR ?? null, repoRoot: process.env.DESK_REPO_ROOT ?? null, cwd: process.cwd() }) + '\\n');
process.stdout.write('START ' + process.argv.slice(2).join(' ') + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (d.includes('flood')) { process.stdout.write('x'.repeat(300 * 1024)); process.stdout.write('END-MARK\\n'); }
  else process.stdout.write('echo:' + d);
});
process.on('SIGHUP', () => process.exit(0));
`);
chmodSync(join(STUBS, 'claude'), 0o755);
// Anything else a refused request names would leave this file behind.
writeFileSync(join(STUBS, 'evil'), `#!/bin/sh\ntouch "${T}/pwned"\n`, { mode: 0o755 });
const PTY = join(DH, 'ptyd', 'node_modules', 'node-pty');
mkdirSync(PTY, { recursive: true });
writeFileSync(join(PTY, 'package.json'), '{"name":"node-pty","version":"0.0.0-stub","main":"index.js"}\n');
writeFileSync(join(PTY, 'index.js'), `const { spawn } = require('node:child_process');
exports.spawn = (file, args, opts) => {
  const c = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const data = [], exit = [];
  const out = (d) => { for (const f of data) f(d.toString('utf8')); };
  c.stdout.on('data', out); c.stderr.on('data', out);
  c.on('exit', (code, signal) => { for (const f of exit) f({ exitCode: code ?? 0, signal: signal ? 1 : 0 }); });
  return { pid: c.pid, onData: (f) => { data.push(f); }, onExit: (f) => { exit.push(f); }, write: (s) => c.stdin.write(s),
    resize: () => {}, kill: (sig) => { try { c.kill(sig); } catch {} } };
};
`);
const lines = (f) => (existsSync(join(T, f)) ? readFileSync(join(T, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const starts = () => lines('starts.jsonl');

// ---- the daemon, as launchd runs it
let daemonOut = '';
const daemon = spawn(process.execPath, [join(BIN, 'desk-ptyd.mjs'), 'serve'], { cwd: T, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
daemon.stdout.on('data', (d) => { daemonOut += d; });
daemon.stderr.on('data', (d) => { daemonOut += d; });
process.on('exit', () => { try { daemon.kill('SIGKILL'); } catch { /* gone */ } for (const s of starts()) try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ } });
const UI = await import(pathToFileURL(join(BIN, 'desk-ui.mjs')).href);
const { makeTerminals } = await import(pathToFileURL(join(BIN, 'desk-ui-terminals.mjs')).href);
const raw = makeTerminals({ socket: SOCK, log: () => {} });
t('the daemon starts and answers', await until(() => raw.available()), true);
if (!(await raw.available())) { console.log(daemonOut); process.exit(1); }

// ---- AC4: only this user can reach the socket
t('AC4 the socket is chmod 600', [statSync(SOCK_AT).isSocket(), (statSync(SOCK_AT).mode & 0o777).toString(8)], [true, '600']);
t('AC4 its folder, open to everyone before, is chmod 700', (statSync(SOCKDIR).mode & 0o777).toString(8), '700');
t('AC4 both are this user\'s', [statSync(SOCK_AT).uid, statSync(SOCKDIR).uid], [process.getuid(), process.getuid()]);

// ---- the server, in this process
function call(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, json, headers: res.headers }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
async function serverOn(port) {
  const server = UI.makeServer({ p: port, log: () => {}, ptyd: SOCK });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const ORIGIN = `http://127.0.0.1:${port}`;
  const r = await call(port, 'POST', '/api/auth/exchange', { headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
  const auth = { Origin: ORIGIN, Cookie: String(r.headers['set-cookie'] ?? '').split(';')[0], 'X-Desk-Load': r.json?.loadToken ?? '' };
  server.meta = async () => (await call(port, 'GET', '/api/meta', { headers: auth })).json;
  return server;
}
const closeServer = (s) => new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); });

let A = await serverOn(PORT);
t('/api/meta says terminals are available while the daemon answers', (await A.meta())?.features, { ptyd: true });

// ---- AC1: /desk-ticket SV-3880 in studia-web runs in SV-3880's worktree on studia-web's subscription
const opened = await A.terminals.openSkill({ repo: 'acme__studia-web', skill: 'desk-ticket', ticket: 'SV-3880' });
t('AC1 the terminal opens', [opened.ok, /^[a-f0-9]{16}$/.test(opened.id ?? ''), opened.subscription], [true, true, 'ops@studia.example']);
await until(() => starts().length === 1);
const s1 = starts()[0] ?? {};
t('AC1 claude runs the skill with its ticket, and nothing else', s1.argv, ['--session-id', opened.sessionId, '/desk-ticket SV-3880']);
t('AC1 in SV-3880\'s worktree', s1.cwd, realpathSync(TREE));
t('AC1 on studia-web\'s subscription, with no API key', [s1.configDir, s1.apiKey, s1.repoDir], [OPS, null, TREE]);
t('AC1 desk still finds the primary checkout as the repo root, not the worktree', s1.repoRoot, ROOT);
const seenA = [];
const att = await A.terminals.attach(opened.id, (ev) => { if (ev.ev === 'data') seenA.push(Buffer.from(ev.data, 'base64')); });
const outA = () => Buffer.concat([Buffer.from(att.scrollback ?? '', 'base64'), ...seenA]).toString('utf8');
t('AC1 its output reaches the server', await until(() => outA().includes(`START --session-id ${opened.sessionId} /desk-ticket SV-3880`)), true);
await A.terminals.write(opened.id, 'hello\n');
t('AC1 and what the server writes reaches claude', await until(() => outA().includes('echo:hello')), true);

t('a ticket a worker is running is refused', [(await A.terminals.openSkill({ repo: 'acme__studia-web', skill: 'desk-ticket', ticket: 'SV-3881' })).error?.code, starts().length], ['running', 1]);
t('a skill name that is not one is refused', [(await A.terminals.openSkill({ repo: 'acme__studia-web', skill: 'desk-ticket; touch x' })).error?.code, starts().length], ['skill', 1]);
t('a repo that is not configured is refused', [(await A.terminals.openSkill({ repo: 'acme__nope', skill: 'desk-ticket' })).error?.code, starts().length], ['repo', 1]);

// ---- AC2: the server restarts; the terminal keeps running and the next server gets its last 256 KB
await A.terminals.write(opened.id, 'flood\n');
t('the flood reaches the server', await until(() => outA().endsWith('END-MARK\n')), true);
const all = Buffer.from(outA(), 'utf8');
await closeServer(A);
await new Promise((r) => setTimeout(r, 200));
t('AC2 after the server closes, the daemon and claude still run', [alive(daemon.pid), alive(s1.pid)], [true, true]);
const B = await serverOn(await freePort());
const listed = await B.terminals.list();
t('AC2 the next server lists the terminal, still running', (listed.items ?? []).map((i) => [i.id, i.state, i.pid]), [[opened.id, 'running', s1.pid]]);
const seenB = [];
const onB = (ev) => { if (ev.ev === 'data') seenB.push(Buffer.from(ev.data, 'base64')); };
const attB = await B.terminals.attach(opened.id, onB);
const back = Buffer.from(attB.scrollback ?? '', 'base64');
t('AC2 on reconnect the server receives exactly the last 256 KB of output', [attB.ok, back.length, back.equals(all.subarray(all.length - 256 * 1024))], [true, 256 * 1024, true]);
t('AC2 and the oldest output is gone', back.includes('START '), false);
await B.terminals.write(opened.id, 'again\n');
t('AC2 the terminal still answers through the next server', await until(() => Buffer.concat(seenB).toString().includes('echo:again')), true);
// Two viewers of one terminal: each gets its output, and one leaving does not silence the other.
const seenC = [];
const attC = await B.terminals.attach(opened.id, (ev) => { if (ev.ev === 'data') seenC.push(Buffer.from(ev.data, 'base64')); });
await B.terminals.write(opened.id, 'both\n');
t('a second viewer attaches with its own scrollback, and both get new output', [attC.ok, Buffer.from(attC.scrollback ?? '', 'base64').length, await until(() => Buffer.concat(seenB).toString().includes('echo:both') && Buffer.concat(seenC).toString().includes('echo:both'))], [true, 256 * 1024, true]);
await B.terminals.detach(opened.id, onB);
await B.terminals.write(opened.id, 'one-left\n');
t('one viewer detaching leaves the other getting output', [await until(() => Buffer.concat(seenC).toString().includes('echo:one-left')), Buffer.concat(seenB).toString().includes('echo:one-left')], [true, false]);

// ---- AC3: anything but claude with a desk skill, or --resume of a known session, is refused and nothing runs
const before = starts().length;
const refusals = [
  ['another binary', { argv: ['evil'], cwd: TREE }, 'argv'],
  ['a shell', { argv: ['/bin/sh', '-c', `touch ${T}/pwned`], cwd: TREE }, 'argv'],
  ['claude by another path', { argv: [join(STUBS, 'evil'), '/desk-ticket SV-3880'], cwd: TREE }, 'argv'],
  ['claude with flags', { argv: ['claude', '--dangerously-skip-permissions', '/desk-ticket SV-3880'], cwd: TREE }, 'argv'],
  ['claude with a flag for a prompt', { argv: ['claude', '-p'], cwd: TREE }, 'argv'],
  ['claude with no skill', { argv: ['claude'], cwd: TREE }, 'argv'],
  ['claude with a prompt', { argv: ['claude', 'delete everything'], cwd: TREE }, 'argv'],
  ['a skill that is not a desk one', { argv: ['claude', '/review SV-3880'], cwd: TREE }, 'argv'],
  ['a desk skill with shell in its arguments', { argv: ['claude', '/desk-ticket SV-3880; touch pwned'], cwd: TREE }, 'argv'],
  ['a desk skill with a flag for an argument', { argv: ['claude', '/desk-ticket --dangerously-skip-permissions'], cwd: TREE }, 'argv'],
  ['a desk skill that is not installed', { argv: ['claude', '/desk-nothing SV-3880'], cwd: TREE }, 'skill'],
  ['a resume of an unknown session', { argv: ['claude', '--resume', randomUUID()], cwd: TREE }, 'session'],
  ['a resume of a path', { argv: ['claude', '--resume', '../../etc/passwd'], cwd: TREE }, 'session'],
  ['a resume with more flags', { argv: ['claude', '--resume', opened.sessionId, '--dangerously-skip-permissions'], cwd: TREE }, 'argv'],
  ['a folder outside every repo', { argv: ['claude', '/desk-ticket SV-3880'], cwd: T }, 'cwd'],
  ['a folder beside the worktrees one', { argv: ['claude', '/desk-ticket SV-3880'], cwd: join(T, 'checkouts') }, 'cwd'],
  ['a relative folder', { argv: ['claude', '/desk-ticket SV-3880'], cwd: 'SV-3880' }, 'cwd'],
  ['PATH in env', { argv: ['claude', '/desk-ticket SV-3880'], cwd: TREE, env: { PATH: STUBS } }, 'env'],
  ['NODE_OPTIONS in env', { argv: ['claude', '/desk-ticket SV-3880'], cwd: TREE, env: { NODE_OPTIONS: `--require ${T}/x.js` } }, 'env'],
  ['a login folder that is not one', { argv: ['claude', '/desk-ticket SV-3880'], cwd: TREE, env: { CLAUDE_CONFIG_DIR: 'login-2' } }, 'env'],
];
for (const [name, req, code] of refusals) t(`AC3 refused: ${name}`, (await raw.open(req)).error?.code, code);
const junk = await raw.request('open', { argv: 'claude /desk-ticket SV-3880', cwd: TREE });
t('AC3 refused: argv as one string', junk.error?.code, 'argv');
await new Promise((r) => setTimeout(r, 300));
t('AC3 nothing ran for any of them', [starts().length - before, existsSync(join(T, 'pwned'))], [0, false]);
const resumed = await raw.open({ argv: ['claude', '--resume', opened.sessionId], cwd: TREE });
t('a resume of a session the daemon opened runs', [resumed.ok, await until(() => starts().length === before + 1), starts().at(-1)?.argv], [true, true, ['--resume', opened.sessionId]]);
await raw.kill(resumed.id);

// ---- the daemon gone: the server reports terminals unavailable and refuses to open one
daemon.kill('SIGTERM');
await until(() => daemon.exitCode !== null);
t('SIGTERM ends the daemon and its terminals', [daemon.exitCode, await until(() => !alive(s1.pid))], [0, true]);
t('/api/meta says terminals are unavailable with no daemon', (await B.meta())?.features, { ptyd: false });
t('opening one is refused as unavailable', [(await B.terminals.openSkill({ repo: 'acme__studia-web', skill: 'desk-ticket', ticket: 'SV-3880' })).error?.code], ['unavailable']);
raw.stop();
await closeServer(B);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
