// suite: desk-ui server (the request guard, sign-in, the snapshot and the bind address)
// covers: desk/bin/desk-ui.mjs
// desk-ui.mjs serve on a throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT and a test-only port, so it
// never meets a server running on 4823. Nothing touches your real ~/.claude, ~/.config/desk or state.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-ui.mjs');

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const T = scratch('desk-ui-');
const PORT = await freePort();
const TOKEN = `tok${'a1'.repeat(30)}`;
const WRONG = `wrong${'b2'.repeat(29)}`;
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_UI_TEST_PORT: String(PORT), PATH: process.env.PATH };
mkdirSync(env.HOME, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', 'acme__widgets'), { recursive: true });
writeFileSync(join(env.DESK_CONFIG_ROOT, 'ui-token'), `${TOKEN}\n`, { mode: 0o600 });
writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', 'acme__widgets', 'config.md'),
  '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `3700` |\n| Autopilot worker concurrency | `2 / 3` | `2 / 3` |\n');
mkdirSync(join(env.DESK_HOME, 'repos', 'acme__widgets'), { recursive: true });
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__widgets', 'queue.json'), JSON.stringify({ version: 1, batch: 'w', concurrency: 2, tickets: {
  'WID-1': { key: 'WID-1', state: 'running', stage: '3/9' },
  'WID-2': { key: 'WID-2', state: 'parked', park: { question: 'which copy?' } },
} }));
writeFileSync(join(env.DESK_HOME, 'installed.json'), JSON.stringify({ commit: 'c0ffee1234567890', dirty: false, at: new Date().toISOString() }));

// The server, its output captured for the log check.
let logged = '';
const srv = spawn('node', [BIN, 'serve'], { env, cwd: T });
srv.stdout.on('data', (d) => { logged += d; });
srv.stderr.on('data', (d) => { logged += d; });
process.on('exit', () => srv.kill());
for (let i = 0; i < 100 && !logged.includes('listening'); i++) await new Promise((r) => setTimeout(r, 50));
t('the server starts on the test port', logged.includes(`listening on http://127.0.0.1:${PORT}`), true);

const responses = [];
function call(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { const r = { status: res.statusCode, headers: res.headers, text }; responses.push(r); resolve(r); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const ORIGIN = `http://127.0.0.1:${PORT}`;
const exchange = (token, origin = ORIGIN) => call('POST', '/api/auth/exchange',
  { headers: { ...(origin === undefined ? {} : { Origin: origin }), 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
const noState = (r) => !/acme__widgets|needs_you|"repos"|WID-/.test(r.text);

// ---- AC5: the token file's token signs in
const ok = await exchange(TOKEN);
const setCookie = String(ok.headers['set-cookie'] ?? '');
const cookie = setCookie.split(';')[0];
const load = JSON.parse(ok.text).loadToken;
t('AC5 the right token signs in', ok.status, 200);
t('AC5 the session cookie is HttpOnly and SameSite=Strict', /^desk_ui=[0-9a-f]{64};/.test(setCookie) && /; HttpOnly/.test(setCookie) && /; SameSite=Strict/.test(setCookie), true);
t('AC5 a per-load token comes back', /^[0-9a-f]{64}$/.test(load ?? ''), true);

// ---- AC1: a cookie without the per-load token header gets nothing
for (const path of ['/api/snapshot', '/api/meta', '/api/nothing']) {
  const r = await call('GET', path, { headers: { Cookie: cookie } });
  t(`AC1 ${path} with only the cookie is refused with 401 and no state`, [r.status, noState(r)], [401, true]);
}
const wrongLoad = await call('GET', '/api/snapshot', { headers: { Cookie: cookie, 'X-Desk-Load': 'f'.repeat(64) } });
t('AC1 a wrong per-load token is refused too', [wrongLoad.status, noState(wrongLoad)], [401, true]);
const headerOnly = await call('GET', '/api/snapshot', { headers: { 'X-Desk-Load': load } });
t('AC1 the per-load token without the cookie is refused', [headerOnly.status, noState(headerOnly)], [401, true]);

// ---- AC2: both give the snapshot
const snap = await call('GET', '/api/snapshot', { headers: { Cookie: cookie, 'X-Desk-Load': load } });
const s = JSON.parse(snap.text);
t('AC2 the snapshot answers 200', snap.status, 200);
t('AC2 it gives the needs-you count', typeof s.needs_you?.count, 'number');
t('AC2 it gives each configured repo\'s summary', s.repos?.map((r) => [r.slug, r.running, r.workers?.cap]), [['acme__widgets', 1, 3]]);
t('AC2 it gives the machine\'s running workers and cap', [s.machine?.running, s.machine?.cap], [1, 10]);
t('AC2 it gives the time and revision it was built at', [!Number.isNaN(Date.parse(s.at)), Number.isInteger(s.rev) && s.rev >= 1], [true, true]);
const again = JSON.parse((await call('GET', '/api/snapshot', { headers: { Cookie: cookie, 'X-Desk-Load': load } })).text);
t('AC2 an unchanged state keeps its revision', again.rev, s.rev);
const shadowed = await call('GET', '/api/snapshot', { headers: { Cookie: `desk_ui=${'0'.repeat(64)}; ${cookie}`, 'X-Desk-Load': load } });
t('a junk desk_ui cookie from another port sent first does not sign the window out', shadowed.status, 200);

// ---- AC3: any other Host is refused
for (const host of ['evil.example', `evil.example:${PORT}`, `127.0.0.1:${PORT + 1}`, `localhost.evil.example:${PORT}`, '']) {
  const r = await call('GET', '/api/snapshot', { headers: { Host: host, Cookie: cookie, 'X-Desk-Load': load } });
  t(`AC3 Host "${host}" is refused with no state`, [r.status, noState(r)], [403, true]);
}
const viaLocalhost = await call('GET', '/api/snapshot', { headers: { Host: `localhost:${PORT}`, Cookie: cookie, 'X-Desk-Load': load } });
t('AC3 Host localhost on the port is answered', viaLocalhost.status, 200);

// ---- AC4: a POST from any other Origin is refused; no response carries a CORS header
for (const origin of ['http://evil.example', `http://localhost:${PORT}`, `http://127.0.0.1:${PORT + 1}`, 'null', undefined]) {
  const r = await exchange(TOKEN, origin);
  t(`AC4 a POST with Origin ${origin ?? '(none)'} is refused, with no cookie`, [r.status, r.headers['set-cookie'] ?? null, noState(r)], [403, null, true]);
}
const crossGet = await call('GET', '/api/snapshot', { headers: { Origin: 'http://evil.example', Cookie: cookie, 'X-Desk-Load': load } });
t('AC4 a GET carrying a foreign Origin is refused', [crossGet.status, noState(crossGet)], [403, true]);
const preflight = await call('OPTIONS', '/api/snapshot', { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } });
t('AC4 a CORS preflight gets no CORS answer', preflight.status, 405);

// ---- AC6: a wrong token is refused, sets no cookie, and neither token is logged
for (const bad of [WRONG, '', TOKEN.slice(0, -1), `${TOKEN}x`, null]) {
  const r = await exchange(bad);
  t(`AC6 the token ${JSON.stringify(bad && `${bad.slice(0, 6)}…`)} is refused with 401 and no cookie`, [r.status, r.headers['set-cookie'] ?? null], [401, null]);
}
const notJson = await call('POST', '/api/auth/exchange', { headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' }, body: TOKEN });
t('AC6 a sign-in that is not JSON is refused with no cookie', [notJson.status, notJson.headers['set-cookie'] ?? null], [415, null]);

// ---- AC12: a signed-in window's root page names the server and its version, and no state
const root = await call('GET', '/', { headers: { Cookie: cookie } });
t('AC12 the root page answers a signed-in window', [root.status, String(root.headers['content-type']).startsWith('text/html')], [200, true]);
t('AC12 it names the server and its version, and holds no state', [/desk-ui c0ffee1234567890/.test(root.text), noState(root)], [true, true]);
const rootOut = await call('GET', '/', {});
t('AC12 a window that has not signed in gets nothing', [rootOut.status, rootOut.text.includes('c0ffee')], [401, false]);

const meta = JSON.parse((await call('GET', '/api/meta', { headers: { Cookie: cookie, 'X-Desk-Load': load } })).text);
t('/api/meta names the version and port', [meta.version, meta.port], ['c0ffee1234567890', PORT]);

t('AC4 no response carried a CORS header', responses.flatMap((r) => Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))), []);
t('every response carries the CSP', responses.every((r) => /frame-ancestors 'none'/.test(r.headers['content-security-policy'] ?? '')), true);

srv.kill();
await new Promise((r) => srv.once('exit', r));
t('the server logged a line per request', logged.split('\n').filter((l) => / (GET|POST|OPTIONS) \//.test(l)).length, responses.length);
t('AC6 nothing the server logged holds any part of either token', [TOKEN, WRONG].map((k) => [k.slice(0, 16), k.slice(-16), k.slice(20, 40)].some((part) => logged.includes(part))), [false, false]);
t('AC6 nothing the server logged holds a session cookie or per-load token', [cookie.split('=')[1], load].some((v) => logged.includes(v)), false);

// ---- AC7: any bind address but 127.0.0.1 exits non-zero naming it, and serves nothing
for (const host of ['0.0.0.0', '::', '192.168.1.20', 'localhost']) {
  const r = spawnSync('node', [BIN, 'serve'], { env: { ...env, DESK_UI_HOST: host }, encoding: 'utf8', timeout: 10000 });
  t(`AC7 binding ${host} exits non-zero naming it`, [r.status !== 0 && r.status !== null, r.stderr.includes(`refusing to bind ${host}`), r.stdout.includes('listening')], [true, true, false]);
}

// The port: taken, the server exits naming it; the test port is read only under a test HOME.
const holder = createServer().listen(PORT, '127.0.0.1');
await new Promise((r) => holder.once('listening', r));
const taken = spawnSync('node', [BIN, 'serve'], { env, encoding: 'utf8', timeout: 10000 });
t('a taken port exits non-zero naming it', [taken.status, taken.stderr.includes(`port ${PORT}`)], [3, true]);
holder.close();
const realHome = spawnSync('node', ['--input-type=module', '-e', `const m = await import(${JSON.stringify(BIN)}); console.log(m.port());`],
  { env: { ...env, HOME: userInfo().homedir, DESK_UI_TEST_PORT: '4999' }, encoding: 'utf8' });
t('DESK_UI_TEST_PORT is ignored under your own HOME', realHome.stdout.trim(), '4823');

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
