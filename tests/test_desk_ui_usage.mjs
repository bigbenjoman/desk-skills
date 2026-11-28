// suite: desk-ui Usage & costs figures and the server's usage probe loop
// layer: L2
// covers: desk/bin/desk-ui-probes.mjs desk/bin/desk-q-model.mjs desk/bin/desk-ui-events.mjs desk/bin/desk-ui.mjs desk/bin/desk-q.mjs
// desk-q-model's subscriptionsJson against a subscriptions file, each Claude login's .claude.json and
// probe log and each repo's Subscription row, on a fixed clock under a throwaway HOME; the probe loop's
// heartbeat and rounds with a stub probe; and desk-q's screen leaving its probes to a fresh heartbeat
// and making them itself with the heartbeat stale or gone.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('desk-ui-usage-');
const H = join(T, 'home');
mkdirSync(join(T, 'bin'));
writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const env = { HOME: H, DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_LOCK_DIR: join(T, 'locks'), DESK_USAGE_DIR: join(T, 'usage'), DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'), DESK_PLATFORM: 'darwin',
  DESK_SKILLS_DIR: join(T, 'skills'), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH', 'DESK_BATCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'DESK_SUBSCRIPTION', 'COLORFGBG', 'COLORTERM', 'NO_COLOR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DESK_AUTOPILOT_WORKER']) delete process.env[k];
Object.assign(process.env, env);
const PERSONAL = join(H, '.claude-logins', 'personal'), WORK = join(H, '.claude-logins', 'work'), SPARE = join(H, '.claude-logins', 'spare');
for (const d of [env.DESK_LOCK_DIR, env.DESK_USAGE_DIR, join(H, '.claude'), PERSONAL, WORK, SPARE]) mkdirSync(d, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = PERSONAL;
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
const account = (path, email, plan) => writeFileSync(path, JSON.stringify({ oauthAccount: { emailAddress: email, planDisplayName: plan } }));
account(join(PERSONAL, '.claude.json'), 'ben@studia.example', 'Max 20x');
account(join(WORK, '.claude.json'), 'ops@studia.example', 'Max 5x');
account(join(SPARE, '.claude.json'), 'ben@personal.example', 'Pro');

// Thursday 26 November 2026, 10:05 local.
const FIXED = new Date(2026, 10, 26, 10, 5).getTime();
const at = (d, h, m) => Math.round(new Date(2026, 10, d, h, m).getTime() / 1000);
const MIN = 60000;

function config(slug, sub = null) {
  const dir = join(env.DESK_CONFIG_ROOT, 'repos', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.md'),
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`3100\` |\n${sub ? `| Subscription | \`default\` | \`${sub}\` |\n` : ''}`);
}
function queue(slug, ready) {
  const q = join(env.DESK_HOME, 'repos', slug, 'queue.json');
  mkdirSync(dirname(q), { recursive: true });
  const tickets = {};
  for (let i = 1; i <= ready; i++) tickets[`K-${i}`] = { key: `K-${i}`, state: 'triaged' };
  writeFileSync(q, JSON.stringify({ version: 1, batch: slug.split('__')[1], concurrency: 2, tickets }));
}
const subscriptions = (rows) => writeFileSync(env.DESK_SUBSCRIPTIONS,
  `| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n${rows.map((r) => `| ${r.map((c) => `\`${c}\``).join(' | ')} |`).join('\n')}\n`);
function claudeReading(key, five, seven, ago = MIN) {
  const path = join(env.DESK_USAGE_DIR, `probe.${key}.log`);
  writeFileSync(path, `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: five[0], resetsAt: five[1] }, seven_day: { utilization: seven[0], resetsAt: seven[1] } } } })}\n`);
  utimesSync(path, (FIXED - ago) / 1000, (FIXED - ago) / 1000);
}

subscriptions([['claude', 'personal', '~/.claude-logins/personal', 'ben@studia.example', 'default'],
  ['claude', 'work', '~/.claude-logins/work', 'ops@studia.example', 'unused'],
  ['claude', 'spare', '~/.claude-logins/spare', 'ben@personal.example', 'off']]);
config('studia__desk-skills'); queue('studia__desk-skills', 3);
config('studia__studia-web', 'ops@studia.example');
config('studia__ai-agents', 'ops@studia.example');
config('studia__studia-reports', 'old@studia.example');
claudeReading('personal', [0.32, at(26, 13, 10)], [0.88, at(1 + 30, 8, 0)]);
claudeReading('work', [0.04, at(26, 14, 55)], [0.12, at(27, 11, 0)], 30 * MIN);

const Q = await import(join(BIN, 'desk-q.mjs'));
const P = await import(join(BIN, 'desk-ui-probes.mjs'));

// ---- the figures the screen draws
let repos = Q.loadRepos(FIXED);
let s = Q.subscriptionsJson(repos, { now: FIXED });
const byEmail = (list, e) => list.find((x) => x.email === e);
t('AC1 the default is ben@studia.example, its 7-day window at 88% with its reset', [s.default_email, byEmail(s.claude, 'ben@studia.example').reading.seven_day],
  ['ben@studia.example', { pct: 88, resets_at: at(31, 8, 0) * 1000 }]);
t('the default card carries its name, plan, folder and state', (({ name, plan, folder, state }) => ({ name, plan, folder, state }))(byEmail(s.claude, 'ben@studia.example')),
  { name: 'personal', plan: 'Max 20x', folder: '~/.claude-logins/personal', state: 'default' });
t('AC2 ops@studia.example is pinned by studia-web and ai-agents', [byEmail(s.claude, 'ops@studia.example').state, byEmail(s.claude, 'ops@studia.example').pinned],
  ['pinned', ['ai-agents', 'studia-web']]);
t('AC2 each repo names the account it runs on', s.repos.map((r) => [r.name, r.email, r.source, r.known]), [
  ['ai-agents', 'ops@studia.example', 'row', true], ['desk-skills', 'ben@studia.example', 'default', true],
  ['studia-reports', 'old@studia.example', 'unknown email', false], ['studia-web', 'ops@studia.example', 'row', true]]);
t('a repo with a Subscription row is not unread', s.repos.map((r) => r.unread), [false, false, false, false]);
// A repo whose Subscription row could not be read (the rows failed, so usageTable gives it `sub` null).
t('a repo whose Subscription row cannot be read is unread, naming no account',
  (({ email, source, known, unread, off }) => ({ email, source, known, unread, off }))(Q.repoSubJson({ slug: 'studia__x', name: 'x', sub: null, workers: 0, ready: 0 })),
  { email: null, source: null, known: false, unread: true, off: null });
t('a subscription set off reads off', byEmail(s.claude, 'ben@personal.example').state, 'off');
t('nothing waits while no subscription is at its limit', s.waiting, []);
t('the probe interval goes with the figures', s.probe_every_ms, 5 * MIN);
t('AC4 no standby, rotation or most-room field or word', /standby|rotation|most room/i.test(JSON.stringify(s)), false);

// ---- AC3, AC6: the default at its 7-day limit, desk-skills waiting with its ready tickets
claudeReading('personal', [0.32, at(26, 13, 10)], [1, at(1 + 30, 8, 0)]);
s = Q.subscriptionsJson(Q.loadRepos(FIXED), { now: FIXED });
t('AC6 the default at its limit carries the limit and its reset', byEmail(s.claude, 'ben@studia.example').limit, { type: 'seven_day', at: at(31, 8, 0) * 1000 });
t('AC3 desk-skills waits for ben@studia.example with its ready tickets, until the reset',
  s.waiting, [{ email: 'ben@studia.example', name: 'personal', type: 'seven_day', at: at(31, 8, 0) * 1000, repos: [{ name: 'desk-skills', ready: 3 }] }]);
claudeReading('personal', [0.32, at(26, 13, 10)], [0.88, at(1 + 30, 8, 0)]);

// ---- every Claude login set off: the default is off, so it is never labelled the default, and the
// repos on it cannot start work
subscriptions([['claude', 'personal', '~/.claude-logins/personal', 'ben@studia.example', 'off'],
  ['claude', 'work', '~/.claude-logins/work', 'ops@studia.example', 'off'],
  ['claude', 'spare', '~/.claude-logins/spare', 'ben@personal.example', 'off']]);
s = Q.subscriptionsJson(Q.loadRepos(FIXED), { now: FIXED });
t('an off default reads off, and is still marked as the default', (({ state, is_default }) => ({ state, is_default }))(byEmail(s.claude, 'ben@studia.example')),
  { state: 'off', is_default: true });
t('no default email while the default is off', s.default_email, null);
t('a repo on an off default is not known to start work', s.repos.find((r) => r.name === 'desk-skills')?.known, false);
subscriptions([['claude', 'personal', '~/.claude-logins/personal', 'ben@studia.example', 'default'],
  ['claude', 'work', '~/.claude-logins/work', 'ops@studia.example', 'unused'],
  ['claude', 'spare', '~/.claude-logins/spare', 'ben@personal.example', 'off']]);

// ---- an unreadable subscriptions file blanks only the Usage & costs figures, not the model
const E = await import(join(BIN, 'desk-ui-events.mjs'));
{
  // A folder where the file should be: reading it fails (EISDIR).
  const unreadable = join(T, 'subscriptions-dir.md');
  mkdirSync(unreadable);
  process.env.DESK_SUBSCRIPTIONS = unreadable;
  let model = null, threw = null;
  try { model = await E.readModel(FIXED); } catch (e) { threw = e.message; }
  process.env.DESK_SUBSCRIPTIONS = env.DESK_SUBSCRIPTIONS;
  t('an unreadable subscriptions file does not fail the read model', threw, null);
  t('the read model carries the subscriptions error, and still its repos',
    [/EISDIR/.test(model?.body?.subscriptions?.error ?? ''), Array.isArray(model?.body?.repos)], [true, true]);
}

// ---- the change stream carries the figures on home, and a probe's end rebuilds it
let builds = 0;
const feed = E.makeFeed({ build: async (now) => { builds += 1; return { at: now, body: { repos: [], subscriptions: { n: builds } }, tickets: {}, batches: [] }; },
  roots: () => [], debounceMs: 5, tickMs: 60000 });
const { EventEmitter } = await import('node:events');
const res = Object.assign(new EventEmitter(), { text: '', writableLength: 0, writeHead() {}, flushHeaders() {}, write(x) { this.text += x; return true; }, end() {}, destroy() {} });
await feed.subscribe({ headers: {} }, res);
const before = builds;
feed.changed();
await new Promise((r) => setTimeout(r, 60));
t('a probe ending (changed) rebuilds the model the watcher cannot see change', builds, before + 1);
const homes = res.text.split('\n\n').filter((f) => /^event: home$/m.test(f)).map((f) => JSON.parse(f.match(/^data: (.*)$/m)[1]));
t('the home event sent to an open window carries the new subscriptions', homes.at(-1)?.subscriptions, { n: before + 1 });
feed.stop();

// ---- the probe loop: its heartbeat, its rounds and stop
const beat = join(T, 'ui', 'scheduler.json');
let clock = FIXED;
const made = [];
let ended = 0;
const loop = P.makeScheduler({ now: () => clock, tickMs: 30000, path: beat, due: () => [{ login: 'a' }, { login: 'b' }],
  probe: async (p) => { made.push(p.login); p.done(); }, changed: () => { ended += 1; } });
await loop.tick();
const b = JSON.parse(readFileSync(beat, 'utf8'));
t('AC13 a tick, with no window open, makes the probes due, one after another', made, ['a', 'b']);
t('each probe ending tells the change stream', ended, 2);
t('the heartbeat names this process, the time and the tick', b, { pid: process.pid, at: FIXED, every_ms: 30000 });
t('AC11 a heartbeat just written is fresh', P.schedulerFresh(FIXED + 10000, beat), true);
t('a heartbeat two ticks old and a little more is still fresh', P.schedulerFresh(FIXED + 70000, beat), true);
t('AC12 a heartbeat older than two ticks and the slack is stale', P.schedulerFresh(FIXED + 76000, beat), false);
writeFileSync(beat, JSON.stringify({ pid: 2 ** 22 + 12345, at: FIXED, every_ms: 30000 }));
t('AC12 a heartbeat from a process that has gone is stale', P.schedulerFresh(FIXED, beat), false);
t('no heartbeat is stale', P.schedulerFresh(FIXED, join(T, 'none.json')), false);
await loop.tick();
loop.stop();
t('stopping removes the heartbeat', existsSync(beat), false);
// One round at a time: a tick while a probe is still starting only writes the heartbeat.
let release;
const slow = P.makeScheduler({ now: () => clock, path: beat, due: () => [{ login: 'x' }], probe: () => new Promise((r) => { release = r; }) });
const first = slow.tick();
await new Promise((r) => setTimeout(r, 20)); // the round reaches its probe
clock += 30000;
slow.tick();
t('a tick during a round writes the heartbeat and starts no second round', [JSON.parse(readFileSync(beat, 'utf8')).at, slow.running], [FIXED + 30000, true]);
release(); await first; slow.stop();

// The server's loop makes the probes desk-q's screen would: here, work, which studia-web and ai-agents
// are pinned to and whose reading is 30 minutes old.
const due = Q.probesDue(Q.loadRepos(FIXED), { now: FIXED }).map((p) => p.login.name);
t('AC13 the probes due are the ones desk-q would make', due, ['work']);

// ---- AC11, AC12: desk-q's screen with the server's heartbeat fresh, then stale
const { PassThrough } = await import('node:stream');
async function screenProbes(beatAt) {
  if (beatAt == null) rmSync(P.beatPath(), { force: true });
  else { mkdirSync(dirname(P.beatPath()), { recursive: true }); writeFileSync(P.beatPath(), JSON.stringify({ pid: process.pid, at: beatAt, every_ms: 30000 })); }
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = { buf: '', columns: 104, rows: 60, write(x) { this.buf += x; }, on() {}, removeListener() {} };
  const calls = [];
  const ui = Q.interactive({ input, output, exit() {}, refreshMs: 600000, clock: () => FIXED, probeMs: 40, probeWith: async (p) => { calls.push(p.login?.name ?? null); return { ran: true }; },
    costWith: () => {}, loginsWith: async () => ({ list: [] }) });
  await new Promise((r) => setTimeout(r, 200));
  ui.finish(0);
  return calls;
}
t('AC11 with the server probing, desk-q makes no probe of its own', await screenProbes(FIXED - 5000), []);
// A login only this screen's CLAUDE_CONFIG_DIR names: the server, started without it, cannot probe it.
const SOLO = join(H, 'solo-login');
mkdirSync(SOLO, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = SOLO;
t('with the server probing, desk-q still probes a login only its own CLAUDE_CONFIG_DIR names', (await screenProbes(FIXED - 5000)).includes('solo-login'), true);
process.env.CLAUDE_CONFIG_DIR = PERSONAL;
t('AC12 with the server\'s heartbeat stale, desk-q probes by itself', (await screenProbes(FIXED - 10 * MIN)).includes('work'), true);
t('AC12 with the server stopped (no heartbeat), desk-q probes by itself', (await screenProbes(null)).includes('work'), true);

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all desk-ui Usage checks passed');
process.exit(fails ? 1 : 0);
