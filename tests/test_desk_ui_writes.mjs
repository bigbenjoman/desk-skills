// suite: desk-ui writes (the allow-listed commands, their statuses, per-repo order and the audit log)
// layer: L2
// covers: desk/bin/desk-ui.mjs
// desk-ui.mjs serve on a throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT and a test-only port, with
// DESK_UI_TEST_BIN pointing at stub commands that record their argv and exit with a chosen code. A
// preload wraps the server's own file system calls and reports any write-mode open of a queue.json.
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-ui.mjs');

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const T = scratch('desk-ui-writes-');
const PORT = await freePort();
const TOKEN = `tok${'c3'.repeat(30)}`;
const STUBS = join(T, 'bin');
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_UI_TEST_PORT: String(PORT), DESK_UI_TEST_BIN: STUBS, DESK_UI_STUB_DIR: T, PATH: process.env.PATH };
mkdirSync(env.HOME, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
mkdirSync(env.DESK_CONFIG_ROOT, { recursive: true });
writeFileSync(join(env.DESK_CONFIG_ROOT, 'ui-token'), `${TOKEN}\n`, { mode: 0o600 });

const repo = (slug, port, tickets) => {
  const root = join(T, 'checkouts', slug);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${root}\` |\n\n` +
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${port}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`2 / 3\` |\n`);
  mkdirSync(join(env.DESK_HOME, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_HOME, 'repos', slug, 'queue.json'), JSON.stringify({ version: 1, batch: 'w', concurrency: 2, tickets }));
  return root;
};
const SW_ROOT = repo('acme__studia-web', 3700, {
  'SV-3844': { key: 'SV-3844', state: 'queued', open_questions: 1 },
  'SV-3845': { key: 'SV-3845', state: 'parked', park: { question: 'awaiting approval: post this comment?',
    approve: { kind: 'jira-comment', target: 'SV-3845', body: 'The fix is in PR #12.' } } },
  'SV-3846': { key: 'SV-3846', state: 'queued' },
});
repo('acme__desk-skills', 3800, { 'DS-1': { key: 'DS-1', state: 'queued', open_questions: 1 } });
// DS-737: the standing batch is held on a usage limit too, so needs-you lists its usage-limit item.
const RESETS = Math.floor(Date.now() / 1000) + 2 * 86400;
{
  const q = join(env.DESK_HOME, 'repos', 'acme__desk-skills', 'queue.json');
  writeFileSync(q, JSON.stringify({ ...JSON.parse(readFileSync(q, 'utf8')), usage_hold: { since: new Date().toISOString(), type: 'seven_day', resets_at: RESETS, paused: [] } }));
}
// DS-7 is archived done in the standing batch and parked live, awaiting approval, in batch E-1.
const DS_HOME = join(env.DESK_HOME, 'repos', 'acme__desk-skills');
writeFileSync(join(DS_HOME, 'queue.archive.json'), JSON.stringify({ tickets: { 'DS-7': { key: 'DS-7', state: 'done', result: { pr: 1 } } } }));
const E1_QUEUE = join(DS_HOME, 'batches', 'E-1', 'queue.json');
mkdirSync(dirname(E1_QUEUE), { recursive: true });
writeFileSync(E1_QUEUE, JSON.stringify({ version: 1, batch: 'E-1', concurrency: 1, tickets: {
  'DS-7': { key: 'DS-7', state: 'parked', park: { question: 'awaiting approval: post this comment?', approve: { kind: 'jira-comment', target: 'DS-7', body: 'Done.' } } } } }));

// The stub for every allow-listed command: what it does is keyed by the ticket it names, in ctl.json.
mkdirSync(STUBS, { recursive: true });
const stub = `import { appendFileSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const key = argv[0] === 'record' ? argv[2] : argv[0];
const dir = process.env.DESK_UI_STUB_DIR;
let c = {};
try { c = JSON.parse(readFileSync(dir + '/ctl.json', 'utf8'))[key] ?? {}; } catch {}
const start = Date.now();
if (c.sleep) await new Promise((r) => setTimeout(r, c.sleep));
appendFileSync(dir + '/calls.jsonl', JSON.stringify({ file: process.argv[1].split('/').pop(), argv, cwd: process.cwd(), queue: process.env.DESK_QUEUE ?? null, state: process.env.DESK_AUTOPILOT_STATE ?? null, start, end: Date.now() }) + '\\n');
process.stdout.write(c.stdout ?? 'recorded\\n');
process.stderr.write(c.stderr ?? '');
process.exit(c.exit ?? 0);
`;
for (const f of ['needs-you.mjs', 'answer.mjs', 'not-now.mjs']) writeFileSync(join(STUBS, f), stub);
const ctl = (o) => writeFileSync(join(T, 'ctl.json'), JSON.stringify(o));
const calls = () => (existsSync(join(T, 'calls.jsonl')) ? readFileSync(join(T, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
ctl({});

// The preload: any write-mode open, write, append, rename or copy naming a queue.json, on stderr.
const GUARD = join(T, 'guard.mjs');
writeFileSync(GUARD, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const Q = (p) => /queue\\.json$/.test(String(p?.toString?.() ?? p));
const say = (how, p) => { if (Q(p)) process.stderr.write('QUEUE-WRITE ' + how + ' ' + p + '\\n'); };
const C = fs.constants;
const writes = (f) => (typeof f === 'string' ? /[wa+]/.test(f) : typeof f === 'number' && (f & (C.O_WRONLY | C.O_RDWR | C.O_APPEND | C.O_CREAT | C.O_TRUNC)) !== 0);
for (const n of ['open', 'openSync']) { const o = fs[n]; fs[n] = function (p, f, ...r) { if (writes(f ?? 'r')) say(n, p); return o.call(this, p, f, ...r); }; }
for (const n of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'truncate', 'truncateSync', 'rm', 'rmSync', 'unlink', 'unlinkSync']) { const o = fs[n]; fs[n] = function (p, ...r) { say(n, p); return o.call(this, p, ...r); }; }
for (const n of ['rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync']) { const o = fs[n]; fs[n] = function (a, b, ...r) { say(n, a); say(n, b); return o.call(this, a, b, ...r); }; }
const P = fs.promises;
for (const n of ['writeFile', 'appendFile', 'truncate', 'rm', 'unlink']) { const o = P[n]; P[n] = function (p, ...r) { say('promises.' + n, p); return o.call(this, p, ...r); }; }
for (const n of ['rename', 'copyFile', 'cp']) { const o = P[n]; P[n] = function (a, b, ...r) { say('promises.' + n, a); say('promises.' + n, b); return o.call(this, a, b, ...r); }; }
{ const o = P.open; P.open = function (p, f, ...r) { if (writes(f ?? 'r')) say('promises.open', p); return o.call(this, p, f, ...r); }; }
syncBuiltinESMExports();
`);
const guardUrl = pathToFileURL(GUARD).href;
const probe = spawnSync('node', ['--import', guardUrl, '--input-type=module', '-e',
  `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(T, 'probe-queue.json'))}, '{}');`], { encoding: 'utf8' });
t('AC1 the guard sees a named-import write to a queue.json', probe.stderr.includes('QUEUE-WRITE'), true);

let logged = '';
const srv = spawn('node', ['--import', guardUrl, BIN, 'serve'], { env, cwd: T });
srv.stdout.on('data', (d) => { logged += d; });
srv.stderr.on('data', (d) => { logged += d; });
process.on('exit', () => srv.kill());
for (let i = 0; i < 300 && !logged.includes('listening'); i++) await new Promise((r) => setTimeout(r, 50));
t('the server starts on the test port', logged.includes(`listening on http://127.0.0.1:${PORT}`), true);

const ORIGIN = `http://127.0.0.1:${PORT}`;
function call(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, json, text }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const signed = await new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/api/auth/exchange',
    headers: { Host: `127.0.0.1:${PORT}`, Origin: ORIGIN, 'Content-Type': 'application/json' } }, (res) => {
    let text = ''; res.on('data', (d) => { text += d; });
    res.on('end', () => resolve({ cookie: String(res.headers['set-cookie'] ?? '').split(';')[0], load: JSON.parse(text).loadToken }));
  });
  req.on('error', reject); req.end(JSON.stringify({ token: TOKEN }));
});
const auth = { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: signed.cookie, 'X-Desk-Load': signed.load };
const post = (path, body) => call('POST', path, { headers: auth, body: JSON.stringify(body) });
// Routes name a repo by its slug; needs-you's argv names it by its name.
const SLUG = { 'studia-web': 'acme__studia-web', 'desk-skills': 'acme__desk-skills' };
const record = (repoName, key, body) => post(`/api/repos/${SLUG[repoName]}/tickets/${key}/record`, body);
const answer = (repoName, key, body) => post(`/api/repos/${SLUG[repoName]}/tickets/${key}/answer`, body);
const last = () => calls().at(-1);

// ---- AC2: the record request runs needs-you's record with the text as its own argument
const r2 = await record('studia-web', 'SV-3844', { action: 'answer', text: 'use the blue one' });
t('AC2 the record answers 200', r2.status, 200);
t('AC2 it runs needs-you.mjs record studia-web SV-3844 answer with the text as one argument', [last()?.file, last()?.argv], ['needs-you.mjs', ['record', 'studia-web', 'SV-3844', 'answer', 'use the blue one']]);
t('AC2 it returns the exit code, stdout and stderr as written', r2.json, { exit: 0, stdout: 'recorded\n', stderr: '' });

// ---- AC3, AC4, AC5: the exit code picks the status
ctl({ 'SV-3844': { exit: 10, stdout: 'nothing yet: the pass reads it next\n' } });
const r3 = await record('studia-web', 'SV-3844', { action: 'answer', text: 'x' });
t('AC3 exit 10 is 202 with the command\'s stdout', [r3.status, r3.json?.exit, r3.json?.stdout], [202, 10, 'nothing yet: the pass reads it next\n']);
ctl({ 'SV-3844': { exit: 11, stdout: 'studia-web SV-3844: answer needs the text to record.\n', stderr: '' } });
const r4 = await record('studia-web', 'SV-3844', { action: 'answer', text: 'y' });
t('AC4 exit 11 is 409 with the command\'s stdout as written', [r4.status, r4.json?.exit, r4.json?.stdout], [409, 11, 'studia-web SV-3844: answer needs the text to record.\n']);
ctl({ 'SV-3844': { exit: 3, stdout: 'half\n', stderr: 'boom\n' } });
const r5 = await record('studia-web', 'SV-3844', { action: 'answer', text: 'z' });
t('AC5 any other exit is 500 with its exit code, stdout and stderr', [r5.status, r5.json], [500, { exit: 3, stdout: 'half\n', stderr: 'boom\n' }]);
ctl({ 'SV-3844': { exit: 1 } });
t('AC5 exit 1 is 500 too', (await record('studia-web', 'SV-3844', { action: 'answer', text: 'z' })).status, 500);
ctl({});

// ---- AC6: shell syntax in the text reaches the command unchanged, as one argument
const nasty = 'ok; rm -rf ~ && echo "$(whoami)" `id` | tee /tmp/x > /dev/null\nnext line';
const before6 = calls().length;
const r6 = await record('studia-web', 'SV-3844', { action: 'answer', text: nasty });
t('AC6 the text arrives unchanged as the last argument', [r6.status, last()?.argv.length, last()?.argv.at(-1) === nasty], [200, 5, true]);
t('AC6 exactly one command ran', calls().length - before6, 1);
const r6a = await answer('studia-web', 'SV-3845', { text: '$(whoami); rm -rf ~' });
t('AC6 answer.mjs gets it unchanged as its last argument', [r6a.status, last()?.file, last()?.argv], [200, 'answer.mjs', ['SV-3845', '$(whoami); rm -rf ~']]);

// ---- AC7: a key that is not a key, a repo not configured, or an action not offered: 400, nothing runs
const before7 = calls().length;
for (const [name, p, body] of [
  ['a lower-case key', '/api/repos/acme__studia-web/tickets/sv-3844/record', { action: 'answer', text: 'a' }],
  ['a key with no dash', '/api/repos/acme__studia-web/tickets/SV3844/record', { action: 'answer', text: 'a' }],
  ['an encoded path in the key', '/api/repos/acme__studia-web/tickets/..%2FSV-1/record', { action: 'answer', text: 'a' }],
  ['a key with a flag in it', '/api/repos/acme__studia-web/tickets/--approve/answer', { text: 'a' }],
  ['a repo that is not configured', '/api/repos/nope/tickets/SV-3844/record', { action: 'answer', text: 'a' }],
  ['a repo named by its name, not its slug', '/api/repos/studia-web/tickets/SV-3844/record', { action: 'answer', text: 'a' }],
  ['an answer for a ticket with no question open', '/api/repos/acme__studia-web/tickets/SV-3846/answer', { text: 'a' }],
  ['an action the item does not offer', '/api/repos/acme__studia-web/tickets/SV-3844/record', { action: 'drop' }],
  ['an action with an argument', '/api/repos/acme__studia-web/tickets/SV-3844/record', { action: 'answer --all', text: 'a' }],
  ['a ticket in another repo', '/api/repos/acme__desk-skills/tickets/SV-3844/record', { action: 'answer', text: 'a' }],
  ['a ticket that needs nothing', '/api/repos/acme__studia-web/tickets/SV-9999/record', { action: 'answer', text: 'a' }],
  ['an answer for a ticket in no batch', '/api/repos/acme__studia-web/tickets/SV-9999/answer', { text: 'a' }],
  ['an approval on a ticket with nothing awaiting one', '/api/repos/acme__studia-web/tickets/SV-3844/answer', { text: 'yes', approve: true }],
  ['answer text that reads as a flag', '/api/repos/acme__studia-web/tickets/SV-3845/answer', { text: '--approve' }],
  ['text that is not a string', '/api/repos/acme__studia-web/tickets/SV-3844/record', { action: 'answer', text: ['a', 'b'] }],
]) {
  const r = await post(p, body);
  t(`AC7 ${name} is refused with 400`, r.status, 400);
}
t('AC7 no command ran for any of them', calls().length - before7, 0);
const notJson = await call('POST', '/api/repos/acme__studia-web/tickets/SV-3844/record', { headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'action=answer' });
t('a write that is not JSON is refused', notJson.status, 415);
const asGet = await call('GET', '/api/repos/acme__studia-web/tickets/SV-3844/record', { headers: { Cookie: auth.Cookie, 'X-Desk-Load': auth['X-Desk-Load'] } });
t('a write route read with GET is refused', asGet.status, 405);
const noLoad = await call('POST', '/api/repos/acme__studia-web/tickets/SV-3844/record', { headers: { ...auth, 'X-Desk-Load': 'f'.repeat(64) }, body: JSON.stringify({ action: 'answer', text: 'a' }) });
const foreign = await call('POST', '/api/repos/acme__studia-web/tickets/SV-3844/record', { headers: { ...auth, Origin: 'http://evil.example' }, body: JSON.stringify({ action: 'answer', text: 'a' }) });
t('a write without the per-load token, or from another Origin, is refused and runs nothing', [noLoad.status, foreign.status, calls().length - before7], [401, 403, 0]);

// ---- AC8: two writes for one repo run one after the other, and answer in order
ctl({ 'SV-3844': { sleep: 700, stdout: 'first\n' }, 'SV-3845': { stdout: 'second\n' } });
const order = [];
const n8 = calls().length;
const a8 = record('studia-web', 'SV-3844', { action: 'answer', text: 'one' }).then((r) => { order.push(r.json?.stdout); return r; });
const b8 = record('studia-web', 'SV-3845', { action: 'resume', text: 'two' }).then((r) => { order.push(r.json?.stdout); return r; });
await Promise.all([a8, b8]);
const [c1, c2] = calls().slice(n8);
t('AC8 both ran', [c1?.argv[2], c2?.argv[2]], ['SV-3844', 'SV-3845']);
t('AC8 the second started only after the first exited', c2?.start >= c1?.end, true);
t('AC8 the window got the results in order', order, ['first\n', 'second\n']);

// ---- AC9: a write for another repo does not wait
ctl({ 'SV-3844': { sleep: 1500, stdout: 'slow\n' }, 'DS-1': { stdout: 'quick\n' } });
const order9 = [];
const n9 = calls().length;
const sw = record('studia-web', 'SV-3844', { action: 'answer', text: 'slow' }).then((r) => order9.push(r.json?.stdout));
await new Promise((r) => setTimeout(r, 300));
const ds = record('desk-skills', 'DS-1', { action: 'answer', text: 'quick' }).then((r) => order9.push(r.json?.stdout));
await Promise.all([sw, ds]);
const run9 = Object.fromEntries(calls().slice(n9).map((c) => [c.argv[2], c]));
t('AC9 desk-skills\'s write finished while studia-web\'s was still running', [order9, run9['DS-1']?.end < run9['SV-3844']?.end], [['quick\n', 'slow\n'], true]);
ctl({});

// ---- AC11: approving a parked gate block runs answer.mjs with --approve, in the repo's checkout
const r11 = await answer('studia-web', 'SV-3845', { text: 'approved as written', approve: true });
t('AC11 the approval answers 200', r11.status, 200);
t('AC11 it runs answer.mjs SV-3845 --approve with the text', [last()?.file, last()?.argv], ['answer.mjs', ['SV-3845', '--approve', 'approved as written']]);
t('AC11 it runs in studia-web\'s checkout', realpathSync(last()?.cwd ?? T), realpathSync(SW_ROOT));
ctl({ 'SV-3845': { exit: 11, stdout: 'SV-3845: refused\n' } });
const r11b = await answer('studia-web', 'SV-3845', { text: 'approved', approve: true });
t('AC11 its result follows the same rules', [r11b.status, r11b.json?.stdout], [409, 'SV-3845: refused\n']);
ctl({});
const r11c = await answer('desk-skills', 'DS-7', { text: 'approved', approve: true });
t('AC11 a ticket live in a named batch is approved there, not as its archived copy in the standing batch',
  [r11c.status, last()?.argv, realpathSync(last()?.queue ?? T)], [200, ['DS-7', '--approve', 'approved'], realpathSync(E1_QUEUE)]);
const r11d = await record('desk-skills', 'DS-7', { action: 'resume', text: 'go on' });
t('a record for a ticket live in a named batch names that batch to needs-you', [r11d.status, last()?.argv.slice(0, 4)], [200, ['record', 'desk-skills:E-1', 'DS-7', 'resume']]);

// ---- DS-737: the record route takes needs-you's item keys, not only ticket keys, while it lists them
const rUsage = await record('desk-skills', 'usage-limit', { action: 'not-now' });
t('DS-737 an item key needs-you lists is recorded', [rUsage.status, last()?.argv], [200, ['record', 'desk-skills', 'usage-limit', 'not-now']]);
const before737 = calls().length;
for (const [name, p, body] of [
  ['an item key the repo does not list', '/api/repos/acme__desk-skills/tickets/step%3Anope/record', { action: 'done' }],
  ['an item key that starts with a dash', '/api/repos/acme__desk-skills/tickets/-usage-limit/record', { action: 'not-now' }],
  ['an item key with a control character', '/api/repos/acme__desk-skills/tickets/usage%0Alimit/record', { action: 'not-now' }],
  ['an item key on the answer route', '/api/repos/acme__desk-skills/tickets/usage-limit/answer', { text: 'a' }],
]) t(`DS-737 ${name} is refused with 400`, (await post(p, body)).status, 400);
t('DS-737 no command ran for any of them', calls().length - before737, 0);

// ---- DS-737: undo-not-now clears the newest entry put off in the last 2 minutes, in its batch's state
const DS_STATE = join(env.HOME, '.desk-autopilot', 'acme__desk-skills');
const E1_STATE = join(DS_STATE, 'batches', 'E-1');
const undo = (key, body = {}) => post(`/api/repos/acme__desk-skills/tickets/${key}/undo-not-now`, body);
const putOff = (dir, entry) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'not-now.jsonl'), `${entry.map((e) => JSON.stringify(e)).join('\n')}\n`); };
const ago = (ms) => new Date(Date.now() - ms).toISOString();
putOff(DS_STATE, [{ key: 'a1', question: 'is DS-1 still wanted?', ticket: 'DS-1', at: ago(10 * 60_000), inputs: {}, hash: 'x' }]);
const before737u = calls().length;
const stale = await undo('DS-1');
t('DS-737 an entry put off 10 minutes ago is not taken back: 400, nothing runs', [stale.status, calls().length - before737u], [400, 0]);
putOff(DS_STATE, [{ key: 'a1', question: 'is DS-1 still wanted?', ticket: 'DS-1', at: ago(60_000), inputs: {}, hash: 'x' }]);
putOff(E1_STATE, [{ key: 'b1', question: 'DS-1 in E-1: start it?', ticket: 'DS-1', at: ago(5_000), inputs: {}, hash: 'y' },
  { key: 'c1', question: 'DS-9 something else', ticket: 'DS-9', at: ago(1_000), inputs: {}, hash: 'z' }]);
const fresh = await undo('DS-1');
t('DS-737 undo-not-now runs not-now.mjs clear with the newest entry\'s question for that key', [fresh.status, last()?.file, last()?.argv], [200, 'not-now.mjs', ['clear', 'DS-1 in E-1: start it?']]);
t('DS-737 it runs in the state of the batch holding that entry', realpathSync(last()?.state ?? T), realpathSync(E1_STATE));
t('DS-737 undo-not-now with a body is refused', (await undo('DS-1', { text: 'x' })).status, 400);
t('DS-737 undo-not-now for a key with nothing put off is refused', (await undo('DS-2')).status, 400);

// ---- DS-737: the Inbox's list carries a usage item's reset, and the recent records log
const RECORDS = join(env.HOME, '.desk-autopilot', 'needs-you-records.jsonl');
writeFileSync(RECORDS, [{ at: ago(7 * 3600_000), batch: 'studia-web', key: 'SV-1', action: 'done', line: 'old' },
  { at: ago(60_000), batch: 'studia-web', key: 'SV-3952', action: 'done', line: 'recorded studia-web SV-3952 done' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
const inbox737 = await call('GET', '/api/inbox?settle=0', { headers: { Cookie: auth.Cookie, 'X-Desk-Load': auth['X-Desk-Load'] } });
t('DS-737 the usage item carries resets_at as an ISO time', inbox737.json?.items?.find((i) => i.key === 'usage-limit')?.resets_at, new Date(RESETS * 1000).toISOString());
t('DS-737 recorded holds the last 6 hours of the records log', inbox737.json?.recorded?.map((e) => [e.key, e.line]), [['SV-3952', 'recorded studia-web SV-3952 done']]);

// ---- any text the length limit allows gets an HTTP answer, however many bytes it takes
const wide = '漢'.repeat(2000);
const rWide = await record('studia-web', 'SV-3844', { action: 'answer', text: wide });
t('2,000 three-byte characters are recorded whole', [rWide.status, last()?.argv.at(-1) === wide], [200, true]);
const ctrl = '\u0001'.repeat(2000);
t('2,000 characters JSON escapes as \\u0001 are recorded too', (await record('studia-web', 'SV-3844', { action: 'answer', text: ctrl })).status, 200);
t('2,001 characters are refused with 400', (await record('studia-web', 'SV-3844', { action: 'answer', text: `${wide}x` })).status, 400);

// ---- AC10: one audit line per write, with the time, route, redacted command and exit code
const AUDIT = join(env.HOME, '.desk-autopilot', 'ui', 'audit.jsonl');
const lines = readFileSync(AUDIT, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
t('AC10 one audit line per command run', lines.length, calls().length);
const a2 = lines[0];
t('AC10 a line holds the time, the route, the command and the exit code', [!Number.isNaN(Date.parse(a2.at)), a2.route, a2.argv, a2.exit],
  [true, '/api/repos/acme__studia-web/tickets/SV-3844/record', ['needs-you.mjs', 'record', 'studia-web', 'SV-3844', 'answer', '<redacted>'], 0]);
t('AC10 an answer\'s line redacts its text and keeps its flag', lines.find((l) => l.argv.includes('--approve'))?.argv, ['answer.mjs', 'SV-3845', '--approve', '<redacted>']);
t('AC10 the exit codes are logged as the commands gave them', lines.slice(1, 5).map((l) => l.exit), [10, 11, 3, 1]);
const auditText = readFileSync(AUDIT, 'utf8');
t('AC10 no free text reaches the audit log', ['use the blue one', 'whoami', 'approved as written', 'slow', 'quick'].some((s) => auditText.includes(s)), false);

// ---- a shutdown lets a write in flight finish: its command's result is answered and audited
// and an open change stream, which never ends by itself, does not hold the stop open.
ctl({ 'SV-3844': { sleep: 1500 } });
const streamEnded = new Promise((resolve) => {
  const req = request({ host: '127.0.0.1', port: PORT, path: '/api/events', headers: { Host: `127.0.0.1:${PORT}`, ...auth } }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', () => resolve(res.statusCode));
  });
  req.on('error', () => resolve(null));
  req.end();
});
const inFlight = answer('studia-web', 'SV-3844', { text: 'answered at shutdown' }).catch(() => ({ status: null }));
await new Promise((r) => setTimeout(r, 700));
const closed = new Promise((r) => srv.once('close', () => r(true)));
srv.kill();
const atStop = await inFlight;
const exited = await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 10_000))]);
const auditAfter = readFileSync(AUDIT, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
t('a write in flight when the server is stopped is answered, and audited', [atStop.status, auditAfter.length - lines.length, auditAfter.at(-1)?.argv],
  [200, 1, ['answer.mjs', 'SV-3844', '<redacted>']]);
t('an open change stream is ended at the stop, and the server exits', [await streamEnded, exited], [200, true]);

// ---- AC1: the server never opened a queue file for writing
t('AC1 the server never opened a queue.json for writing', logged.split('\n').filter((l) => l.startsWith('QUEUE-WRITE')), []);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
