// suite: desk-q reads desk-ui's server (its listing while the server answers, the files when it does not)
// covers: desk/bin/desk-q-server.mjs desk/bin/desk-q.mjs desk/bin/desk-q-model.mjs desk/bin/desk-ui.mjs desk/bin/desk-ui-events.mjs
// desk-ui's real server (makeServer) on a test-only port, and stub servers on others, against two fixture
// repos under a throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT. One batch is handed to the supervisor, so a
// read of the files runs launchctl (a fake one on PATH, which also stands in for git and systemctl and
// notes each start in a log). Nothing touches your real ~/.claude, ~/.config/desk or state.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';
import { call as callPort, freePort } from './local-http.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const T = scratch('desk-q-server-');
const PORT = await freePort();
const TOKEN = `tok${'d4'.repeat(30)}`;
const SHIMS = join(T, 'bin');
const STARTS = join(T, 'starts.log');
mkdirSync(SHIMS);
// Each start is logged only where SHIM_LOG is set: in the desk-q runs, not in this process's server.
for (const b of ['git', 'launchctl', 'systemctl']) writeFileSync(join(SHIMS, b), `#!/bin/sh\n[ -n "$SHIM_LOG" ] && echo "${b} $*" >> "$SHIM_LOG"\nexit 1\n`, { mode: 0o755 });
for (const k of Object.keys(process.env)) if (k.startsWith('DESK_') || k.startsWith('AUTOPILOT_')) delete process.env[k];
Object.assign(process.env, { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills'), DESK_LOCK_DIR: join(T, 'locks'), DESK_UI_TEST_PORT: String(PORT), PATH: `${SHIMS}:${process.env.PATH}`, NO_COLOR: '1' });
const env = { ...process.env };
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
const TOKEN_FILE = join(env.DESK_CONFIG_ROOT, 'ui-token');
const REPOS = { acme__widgets: 3700, acme__gadgets: 3800 };
const queueOf = (slug) => join(env.DESK_HOME, 'repos', slug, 'queue.json');
const writeQueue = (slug, tickets, extra = {}) => {
  const f = queueOf(slug);
  writeFileSync(`${f}.tmp`, JSON.stringify({ version: 1, batch: slug, concurrency: 2, ...extra,
    tickets: Object.fromEntries(tickets.map((x) => [x.key, { added_at: iso(NOW - 3600000), lane: 'A', ...x }])) }));
  renameSync(`${f}.tmp`, f);
};
for (const [slug, p] of Object.entries(REPOS)) {
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${p}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`2 / 3\` |\n`);
  mkdirSync(dirname(queueOf(slug)), { recursive: true });
  mkdirSync(join(env.HOME, '.desk-autopilot', slug, 'logs'), { recursive: true });
}
const WIDGETS = [{ key: 'WID-1', state: 'running', stage: '3/9' }, { key: 'WID-2', state: 'parked', park: { question: 'which copy?' } }, { key: 'WID-4', state: 'queued' }];
writeQueue('acme__widgets', WIDGETS, { supervised: true });
writeQueue('acme__gadgets', [{ key: 'GAD-1', state: 'queued' }, { key: 'GAD-2', state: 'running', stage: '4/9' }]);
writeFileSync(join(env.DESK_HOME, 'installed.json'), JSON.stringify({ commit: 'c0ffee1234567890', dirty: false, at: iso(NOW) }));
const withToken = () => writeFileSync(TOKEN_FILE, `${TOKEN}\n`, { mode: 0o600 });

// desk-q run as the person runs it, its git, launchctl and systemctl starts noted in STARTS.
const deskQ = (args, port = PORT) => new Promise((resolve) => {
  writeFileSync(STARTS, '');
  const at = Date.now();
  const p = spawn(process.execPath, [join(BIN, 'desk-q.mjs'), ...args], { env: { ...env, DESK_UI_TEST_PORT: String(port), SHIM_LOG: STARTS } });
  let stdout = '', stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - at, starts: readFileSync(STARTS, 'utf8').split('\n').filter(Boolean) }));
});

// ---- What reading the files prints, with no token file and so no server asked
rmSync(TOKEN_FILE, { force: true });
const files = await deskQ(['--plain']);
t('the files read prints home with both repos', [files.code, files.stdout.includes('widgets'), files.stdout.includes('gadgets')], [0, true, true]);
t('the files read runs launchctl for the supervised batch (the fake one counts)', files.starts.some((s) => s.startsWith('launchctl')), true);
withToken();

// ---- AC2: the server stopped (nothing on its port), desk-q reads the files and prints the same
const { serverModel, SERVER_WAIT_MS } = await import(join(BIN, 'desk-q-server.mjs'));
const down = await deskQ(['--plain']);
t('AC2 with the server stopped desk-q prints what the files print', [down.code, down.stderr, down.stdout], [0, '', files.stdout]);
let at = Date.now();
t('AC2 the server read finds nothing on the port', await serverModel(), null);
t('AC2 and gives up at once', Date.now() - at < SERVER_WAIT_MS, true);
// A server that takes the connection and never answers is waited on for SERVER_WAIT_MS at most.
const HUNG = await freePort();
const hung = createTcp(() => {}).listen(HUNG, '127.0.0.1');
await new Promise((r) => hung.once('listening', r));
process.env.DESK_UI_TEST_PORT = String(HUNG);
at = Date.now();
const hungRead = await serverModel();
const hungMs = Date.now() - at;
t('AC2 a server that never answers is given up on', hungRead, null);
t(`AC2 after no more than ${SERVER_WAIT_MS} ms (and a little for the timer)`, hungMs >= SERVER_WAIT_MS - 5 && hungMs < SERVER_WAIT_MS + 100, true);
const hungRun = await deskQ(['--plain'], HUNG);
t('AC2 desk-q against it prints what the files print', [hungRun.code, hungRun.stdout], [0, files.stdout]);
hung.close();
process.env.DESK_UI_TEST_PORT = String(PORT);

// ---- AC1: the server running, desk-q prints the same text from its listing and starts no git or launchctl
const { makeServer } = await import(join(BIN, 'desk-ui.mjs'));
const served = [];
const server = makeServer({ p: PORT, log: (line) => served.push(line), events: { tickMs: 60_000 } });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
await server.feed.current(); // the listing is read once, as the long-lived server will have
const up = await deskQ(['--plain']);
t('AC1 with the server running desk-q prints the same text as the files', [up.code, up.stderr, up.stdout], [0, '', files.stdout]);
t('AC1 it read the server\'s listing', served.some((l) => / GET \/api\/model 200$/.test(l)), true);
t('AC1 and started no git, launchctl or systemctl', up.starts, []);
const upAll = await deskQ(['--plain', '--all']);
server.close();
await new Promise((r) => server.once('close', r));
const filesAll = await deskQ(['--plain', '--all']);
t('AC1 --all reads the server too, and prints the same as the files', [upAll.starts, upAll.stdout], [[], filesAll.stdout]);

// ---- The route: only the token file's token, sent as a bearer, from no browser
const server2 = makeServer({ p: PORT, log: () => {}, events: { tickMs: 60_000 } });
await new Promise((r) => server2.listen(PORT, '127.0.0.1', r));
const call = (headers, method = 'GET', path = '/api/model') => callPort(PORT, method, path, { headers });
const bearer = { Authorization: `Bearer ${TOKEN}` };
const good = await call(bearer);
const wire = JSON.parse(good.text);
t('the bearer token gets the listing', [good.status, wire.v, wire.repos.map((r) => r.slug).sort()], [200, 1, ['acme__gadgets', 'acme__widgets']]);
t('the listing names each row\'s ticket by key', wire.repos.find((r) => r.slug === 'acme__widgets').rows.map((x) => x.key).sort(), ['WID-1', 'WID-2', 'WID-4']);
t('and carries no hold context and no token', [wire.repos.some((r) => 'ctx' in r), good.text.includes(TOKEN)], [false, false]);
t('it signs nobody in', good.headers['set-cookie'] ?? null, null);
const same = await call(bearer, 'GET', `/api/model?at=${wire.at}`);
t('with ?at= naming the listing held, an unchanged one is only { v, at, same }', JSON.parse(same.text), { v: 1, at: wire.at, same: true });
t('a wrong token is refused', (await call({ Authorization: `Bearer ${'x'.repeat(TOKEN.length)}` })).status, 401);
t('a token that is not a bearer is refused', (await call({ Authorization: TOKEN })).status, 401);
t('an overlong one is refused', (await call({ Authorization: `Bearer ${'y'.repeat(300)}` })).status, 401);
t('the bearer with any Origin is refused, the app\'s own too', [(await call({ ...bearer, Origin: 'http://evil.test' })).status, (await call({ ...bearer, Origin: `http://127.0.0.1:${PORT}` })).status], [403, 403]);
t('the bearer beside a session cookie is refused', (await call({ ...bearer, Cookie: 'desk_ui=abc' })).status, 400);
t('the bearer on HEAD is refused', (await call(bearer, 'HEAD')).status, 405);
t('no bearer and no session is refused', (await call({})).status, 401);
t('the bearer opens no other route', (await call(bearer, 'GET', '/api/snapshot')).status, 401);
rmSync(TOKEN_FILE);
t('with no token file the bearer is refused', (await call(bearer)).status, 401);
withToken();

// ---- AC4: an open screen reading from the server keeps going on the files once the server stops
const Q = await import(join(BIN, 'desk-q.mjs'));
const start = await serverModel();
t('AC4 the screen opens on the server\'s listing', Array.isArray(start?.repos) && start.repos.length === 2, true);
const asks = [];
const input = new PassThrough();
Object.assign(input, { isTTY: true, setRawMode() {} });
const output = { buf: '', columns: 120, rows: 30, write(s) { this.buf += s; }, on() {}, removeListener() {} };
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const frames = () => output.buf.split('\x1b[H').length - 1;
const frame = () => output.buf.split('\x1b[H').at(-1).replace(ANSI, '').split('\r\n');
const ui = Q.interactive({ input, output, start: { kind: 'repo', slug: 'acme__widgets' }, served: start, exit() {}, opener() {}, refreshMs: 40, probeMs: 600000,
  probeWith: async () => ({ ran: false }), costWith: () => ({ started: false }),
  serverWith: (o) => { asks.push(o.since); return serverModel(o); } });
await sleep(200);
t('AC4 each refresh asks the server for anything newer than the listing it holds', asks.length > 0 && asks.every((a) => a === start.at), true);
t('AC4 the screen shows the queue', frame().some((l) => l.includes('WID-4')), true);
server2.close();
await new Promise((r) => server2.once('close', r));
writeQueue('acme__widgets', [...WIDGETS, { key: 'WID-9', state: 'queued' }], { supervised: true });
const asked = asks.length;
await sleep(400);
const f1 = frames();
await sleep(200);
t('AC4 once the server stops, the next refresh reads the files and shows the change', frame().some((l) => l.includes('WID-9')), true);
t('AC4 the screen keeps going', frames() > f1, true);
t('AC4 and asks the server no more', asks.length, asked + 1);
ui.finish(0);

// ---- AC3: a server answering with a version desk-q does not know, desk-q reads the files
const STUB = await freePort();
const stub = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...wire, v: 999 })); });
await new Promise((r) => stub.listen(STUB, '127.0.0.1', r));
process.env.DESK_UI_TEST_PORT = String(STUB);
t('AC3 a listing of an unknown version is not read', await serverModel(), null);
process.env.DESK_UI_TEST_PORT = String(PORT);
const files2 = await deskQ(['--plain']);
const odd = await deskQ(['--plain'], STUB);
t('AC3 desk-q prints what the files print', [odd.code, odd.stdout], [0, files2.stdout]);
t('AC3 read from the files, which run launchctl', odd.starts.some((s) => s.startsWith('launchctl')), true);
stub.close();

console.log(fails ? `${fails} FAILED` : 'all desk-q server checks passed');
process.exit(fails ? 1 : 0);
