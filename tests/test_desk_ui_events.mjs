// suite: desk-ui change stream (the watcher, the diff by repo and ticket, resume and the clock tick)
// covers: desk/bin/desk-ui-events.mjs desk/bin/desk-ui.mjs
// The desk-ui server in this process on a throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT and a
// test-only port, with fixture queue files it rewrites while a window's stream is open. Its clock,
// ping interval and event ring are the test's, so nothing waits fifteen minutes or fifteen seconds.
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BINDIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(20); } return !!pred(); };
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const T = scratch('desk-ui-events-');
const PORT = await freePort();
const TOKEN = `tok${'c3'.repeat(30)}`;
Object.assign(process.env, { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md') });
delete process.env.DESK_AUTOPILOT_STATE; delete process.env.DESK_QUEUE;
const env = { ...process.env };
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
mkdirSync(env.DESK_CONFIG_ROOT, { recursive: true });
writeFileSync(join(env.DESK_CONFIG_ROOT, 'ui-token'), `${TOKEN}\n`, { mode: 0o600 });
const REPOS = { acme__widgets: 3700, acme__gadgets: 3800 };
const queueOf = (slug) => join(env.DESK_HOME, 'repos', slug, 'queue.json');
const stateOf = (slug) => join(env.HOME, '.desk-autopilot', slug);
// Written whole and renamed into place, as desk writes a queue.
const writeQueue = (slug, tickets) => {
  const f = queueOf(slug);
  writeFileSync(`${f}.tmp`, JSON.stringify({ version: 1, batch: 'w', concurrency: 2, tickets: Object.fromEntries(tickets.map((x) => [x.key, x])) }));
  renameSync(`${f}.tmp`, f);
};
for (const [slug, p] of Object.entries(REPOS)) {
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${p}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`2 / 3\` |\n`);
  mkdirSync(dirname(queueOf(slug)), { recursive: true });
  mkdirSync(join(stateOf(slug), 'logs'), { recursive: true });
}
const WID = {
  1: { key: 'WID-1', state: 'running', stage: '3/9' },
  2: { key: 'WID-2', state: 'parked', park: { question: 'which copy?' } },
  4: { key: 'WID-4', state: 'queued' },
};
writeQueue('acme__widgets', [WID[1], WID[2], WID[4]]);
writeQueue('acme__gadgets', [{ key: 'GAD-1', state: 'queued' }, { key: 'GAD-2', state: 'running', stage: '4/9' }]);
writeFileSync(join(env.DESK_HOME, 'installed.json'), JSON.stringify({ commit: 'c0ffee1234567890', dirty: false, at: new Date().toISOString() }));

// The server, with the test's clock: `skew` moves it forward without anyone waiting.
let skew = 0;
const RING_TEST = 8, PING_TEST = 400;
const { makeServer } = await import(join(BINDIR, 'desk-ui.mjs'));
const { LIVE_MS, beatFile } = await import(join(BINDIR, 'borrow.mjs'));
const server = makeServer({ p: PORT, log: () => {}, events: { now: () => Date.now() + skew, tickMs: 60_000, pingMs: PING_TEST, ring: RING_TEST } });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const feed = server.feed;

const ORIGIN = `http://127.0.0.1:${PORT}`;
function call(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const ok = await call('POST', '/api/auth/exchange', { headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
const cookie = String(ok.headers['set-cookie'] ?? '').split(';')[0];
const load = JSON.parse(ok.text).loadToken;
const signedIn = { Cookie: cookie, 'X-Desk-Load': load };

// A window's stream: every event as { id, event, data, at }, in order.
function stream({ since = null, headers = signedIn, path = '/api/events' } = {}) {
  const s = { events: [], status: null, type: null };
  let buf = '';
  s.req = request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers: { Host: `127.0.0.1:${PORT}`, ...headers, ...(since == null ? {} : { 'Last-Event-ID': String(since) }) } }, (res) => {
    s.status = res.statusCode; s.type = res.headers['content-type'] ?? null;
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const e = { id: null, event: null, data: null, at: Date.now() };
        for (const line of buf.slice(0, i).split('\n')) {
          const j = line.indexOf(': ');
          const [k, v] = [line.slice(0, j), line.slice(j + 2)];
          if (k === 'id') e.id = Number(v); else if (k === 'event') e.event = v; else if (k === 'data') e.data = JSON.parse(v);
        }
        buf = buf.slice(i + 2);
        s.events.push(e);
      }
    });
  });
  s.req.on('error', () => {});
  s.req.end();
  s.real = () => s.events.filter((e) => e.event !== 'ping');
  s.close = () => s.req.destroy();
  return s;
}
// A window's view, kept by applying each event to the snapshot.
function view(events) {
  let v = null;
  for (const e of events) {
    if (e.event === 'snapshot') v = { home: { needs_you: e.data.needs_you, machine: e.data.machine }, repos: Object.fromEntries(e.data.repos.map((r) => [r.slug, r])), tickets: Object.fromEntries(Object.entries(e.data.tickets).map(([s, rows]) => [s, Object.fromEntries(rows.map((x) => [x.key, x]))])) };
    else if (!v) continue;
    else if (e.event === 'home') v.home = { ...v.home, ...e.data };
    else if (e.event === 'repo') { if (e.data.summary) v.repos[e.data.slug] = e.data.summary; else delete v.repos[e.data.slug]; }
    else if (e.event === 'tickets') {
      const rows = (v.tickets[e.data.slug] ??= {});
      for (const x of e.data.upsert) rows[x.key] = x;
      for (const k of e.data.remove) delete rows[k];
    }
  }
  return v;
}
const counts = (v) => ({ needs: v.home.needs_you.count, repos: Object.values(v.repos).map((r) => [r.slug, r.running, r.ready, r.needs_you]).sort() });
const deskQ = () => {
  const r = spawnSync('node', [join(BINDIR, 'desk-q.mjs'), '--json', 'home', '--all'], { env, encoding: 'utf8', timeout: 30_000 });
  const j = JSON.parse(r.stdout);
  return { needs: j.needs_you.count, repos: j.repos.map((x) => [x.slug, x.running, x.ready, x.needs_you]).sort() };
};

// ---- the first event is a snapshot of every repo and its ticket rows
const w = stream();
await waitFor(() => w.events.length > 0);
const first = w.events[0];
t('a new stream answers 200 as an event stream', [w.status, String(w.type).startsWith('text/event-stream')], [200, true]);
t('its first event is a snapshot of every repo', [first?.event, first?.data?.repos?.map((r) => r.slug).sort()], ['snapshot', ['acme__gadgets', 'acme__widgets']]);
t('the snapshot carries each repo\'s ticket rows by key', Object.fromEntries(Object.entries(first?.data?.tickets ?? {}).map(([s, rows]) => [s, rows.map((x) => x.key).sort()])),
  { acme__widgets: ['WID-1', 'WID-2', 'WID-4'], acme__gadgets: ['GAD-1', 'GAD-2'] });
t('the snapshot names its revision as its event id', first?.id, first?.data?.rev);
t('the snapshot\'s counts are desk-q\'s', counts(view(w.events)), deskQ());
await sleep(300); // anything desk-q's own read wrote has settled

// ---- AC9: a quiet stream is pinged
const quietFrom = w.events.length;
await sleep(PING_TEST * 2 + 200);
const quiet = w.events.slice(quietFrom);
t('AC9 a stream with no change is sent a ping once the interval passes', quiet.length > 0 && quiet.every((e) => e.event === 'ping'), true);
t('AC9 a ping carries the time and no revision', [quiet[0]?.id ?? null, !Number.isNaN(Date.parse(quiet[0]?.data?.at))], [null, true]);

// ---- AC3: logs growing change nothing
const builtBefore = feed.builds.length, seenBefore = w.real().length;
for (let i = 0; i < 10; i++) {
  appendFileSync(join(stateOf('acme__widgets'), 'logs', 'WID-1.log'), `{"type":"assistant","n":${i}}\n`);
  appendFileSync(join(stateOf('acme__gadgets'), 'logs', 'GAD-2.log'), `{"type":"assistant","n":${i}}\n`);
  await sleep(50);
}
await sleep(700);
t('AC3 growing worker logs rebuild nothing', feed.builds.length - builtBefore, 0);
t('AC3 and send no repo or ticket event', w.real().slice(seenBefore).map((e) => e.event), []);

// ---- AC1 and AC5: a pass's write reaches the stream within a second, for its repo alone
const from = w.events.length;
const wrote = Date.now();
writeQueue('acme__widgets', [WID[1], { key: 'WID-2', state: 'running', stage: '2/9' }, { key: 'WID-3', state: 'queued' }]);
await waitFor(() => w.events.slice(from).some((e) => e.event === 'tickets'), 2000);
await sleep(400);
const change = w.events.slice(from).filter((e) => e.event !== 'ping');
const firstAt = change[0]?.at ?? Infinity;
t('AC1 the change reaches the stream within 1 s of the write', firstAt - wrote < 1000, true);
t('AC1 the window\'s counts then equal desk-q --json home\'s for the same state', counts(view(w.events)), deskQ());
t('AC5 only desk-skills\' repo is named', [...new Set(change.map((e) => e.data.slug).filter(Boolean))], ['acme__widgets']);
t('AC5 its repo event carries its summary', change.filter((e) => e.event === 'repo').map((e) => [e.data.summary?.slug, e.data.summary?.running]), [['acme__widgets', 2]]);
const tix = change.filter((e) => e.event === 'tickets').map((e) => e.data);
t('AC5 only the ticket rows that changed or left, by key', [tix.flatMap((x) => x.upsert.map((r) => r.key)).sort(), tix.flatMap((x) => x.remove)], [['WID-2', 'WID-3'], ['WID-4']]);
t('each event has its own revision, in order', change.every((e, i) => Number.isInteger(e.id) && (i === 0 || e.id === change[i - 1].id + 1)), true);
await sleep(300);

// ---- AC4: a burst of writes is one rebuild per 250 ms at most
const burstFrom = feed.builds.length;
for (let i = 0; i < 20; i++) {
  writeQueue('acme__widgets', [WID[1], { key: 'WID-2', state: 'running', stage: `${(i % 8) + 1}/9` }, { key: 'WID-3', state: 'queued', n: i }]);
  await sleep(10);
}
await sleep(1200);
const burst = feed.builds.slice(burstFrom);
const gaps = burst.slice(1).map((x, i) => x - burst[i]);
t('AC4 20 writes in 200 ms are rebuilt at least once', burst.length >= 1, true);
t('AC4 and never twice within 250 ms', gaps.every((g) => g >= 250), true);
t('AC4 the last write is in the model', feed.snapshot().tickets.acme__widgets.find((x) => x.key === 'WID-3') != null, true);

// ---- AC8: a heartbeat ageing past LIVE_MS is sent on the next clock tick, with no write
const beat = beatFile(stateOf('acme__widgets'), queueOf('acme__widgets'));
mkdirSync(dirname(beat), { recursive: true });
const beatAt = new Date(Date.now() - LIVE_MS + 3000).toISOString();
writeFileSync(beat, JSON.stringify({ queue: queueOf('acme__widgets'), batch: null, pid: 1, at: beatAt, pass: beatAt }));
await waitFor(() => w.real().some((e) => e.event === 'repo' && e.data.slug === 'acme__widgets' && e.data.summary?.live === true));
t('AC8 a fresh heartbeat is sent as the repo going live', view(w.events).repos.acme__widgets?.live, true);
await sleep(300);
const tickFrom = w.events.length, tickBuilds = feed.builds.length;
skew = 5000;
await sleep(300);
t('AC8 the clock passing the threshold sends nothing before the tick', [feed.builds.length - tickBuilds, w.events.slice(tickFrom).filter((e) => e.event !== 'ping').length], [0, 0]);
feed.tick();
await waitFor(() => w.events.slice(tickFrom).some((e) => e.event === 'repo'));
const aged = w.events.slice(tickFrom).filter((e) => e.event === 'repo').map((e) => [e.data.slug, e.data.summary?.live]);
t('AC8 the next tick sends that repo\'s summary with it no longer live', aged, [['acme__widgets', false]]);
skew = 0;
feed.tick();
await sleep(500);

// ---- AC6: a window that reconnects with a revision the ring still covers gets only what followed
const ids = w.real().map((e) => e.id);
const last = ids.at(-1);
const back = last - 2;
const again = stream({ since: back });
await waitFor(() => again.real().length >= 2);
await sleep(200);
t('AC6 a reconnect with a held revision gets only the events after it', again.real().map((e) => e.id), [back + 1, back + 2]);
t('AC6 and no snapshot', again.real().some((e) => e.event === 'snapshot'), false);
const viaQuery = stream({ path: `/api/events?since=${back}` });
await waitFor(() => viaQuery.real().length >= 2);
t('AC6 ?since= resumes as Last-Event-ID does', viaQuery.real().map((e) => e.id), [back + 1, back + 2]);
const current = stream({ since: last });
await sleep(300);
t('AC6 a window already at the latest revision is sent nothing to catch up', current.real().length, 0);
again.close(); viaQuery.close(); current.close();

// ---- AC7: a revision older than the ring holds starts with a snapshot
t('the ring has dropped early events by now', last > RING_TEST + 1, true);
for (const old of [1, 0, last + 50]) {
  const stale = stream({ since: old });
  await waitFor(() => stale.real().length > 0);
  t(`AC7 a reconnect from revision ${old} gets a full snapshot first`, [stale.real()[0]?.event, stale.real()[0]?.data?.rev], ['snapshot', last]);
  stale.close();
}

// ---- AC2: a stream or WebSocket upgrade from any Origin but the app's is refused
for (const o of ['http://evil.example', 'null', `http://localhost:${PORT}`, `http://127.0.0.1:${PORT + 1}`]) {
  const bad = stream({ headers: { ...signedIn, Origin: o } });
  await waitFor(() => bad.status != null);
  await sleep(100);
  t(`AC2 a stream with Origin ${o} is refused`, [bad.status, bad.events.length], [403, 0]);
  bad.close();
}
const right = stream({ headers: { ...signedIn, Origin: ORIGIN } });
await waitFor(() => right.status != null);
t('AC2 a stream with the app\'s Origin opens', right.status, 200);
right.close();
const outsider = stream({ headers: { Cookie: cookie } });
await waitFor(() => outsider.status != null);
t('a stream without the per-load token is refused', outsider.status, 401);
const upgrade = (origin) => new Promise((resolve) => {
  const s = connect(PORT, '127.0.0.1');
  let got = '';
  s.on('data', (d) => { got += d; });
  s.on('close', () => resolve(got.split('\r\n')[0]));
  s.on('error', () => resolve(got.split('\r\n')[0]));
  s.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n${origin == null ? '' : `Origin: ${origin}\r\n`}Connection: Upgrade\r\nUpgrade: websocket\r\n`
    + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: ${cookie}\r\nX-Desk-Load: ${load}\r\n\r\n`);
});
for (const o of ['http://evil.example', 'null', null]) t(`AC2 a WebSocket upgrade with Origin ${o ?? '(none)'} is refused`, await upgrade(o), 'HTTP/1.1 403 Forbidden');
t('a WebSocket upgrade from the app has no route yet', await upgrade(ORIGIN), 'HTTP/1.1 404 Not Found');

// ---- the snapshot route reads the same model and revision
const snap = JSON.parse((await call('GET', '/api/snapshot', { headers: signedIn })).text);
t('/api/snapshot carries the stream\'s revision', snap.rev, feed.rev);

w.close();
await sleep(100);
t('a closed window is dropped', feed.clients, 0);
feed.stop();
server.close();
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
