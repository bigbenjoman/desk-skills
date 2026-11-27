// suite: desk-ui Settings reads (a repo's desk setup, subscriptions, the install, the app build's `server` event)
// layer: L1
// covers: desk/bin/desk-ui-settings.mjs desk/bin/desk-ui.mjs desk/bin/desk-ui-events.mjs desk/bin/desk-app.mjs desk/shell/app.mjs
// The server on a throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT and a free port, with stubs for main's
// tests check, the skill and plugin count and the log opener, so nothing reads GitHub, opens a window or
// touches your real ~/.claude or ~/.config/desk.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';
import { call as callPort, freePort } from './local-http.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T = scratch('desk-ui-settings-');
const HOME = join(T, 'home');
const DESK_HOME = join(T, 'deskhome');
const CONFIG = join(T, 'config');
Object.assign(process.env, { HOME, DESK_HOME, DESK_CONFIG_ROOT: CONFIG, DESK_MACHINE: join(T, 'machine.md'),
  DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'), DESK_MAINT_DIR: join(T, 'maint') });
for (const d of [HOME, DESK_HOME, join(CONFIG, 'repos')]) mkdirSync(d, { recursive: true });
// The login this test runs under is not one of the test's subscriptions.
delete process.env.CLAUDE_CONFIG_DIR;
const TOKEN = ['tok', 'e5'.repeat(30)].join('');
writeFileSync(join(CONFIG, 'ui-token'), `${TOKEN}\n`, { mode: 0o600 });

// studia-web's desk setup: the template, with a few rows set and its Jira site left TODO.
const template = readFileSync(join(ROOT, 'desk-config.md'), 'utf8');
const setRow = (text, start, value) => text.split('\n').map((l) => (l.startsWith(start) ? l.replace(/`TODO`[^|]*\|\s*$/, `\`${value}\` |`) : l)).join('\n');
let cfg = template;
cfg = setRow(cfg, '| `pr-merge-green` |', 'ask');
cfg = setRow(cfg, '| `pr-ready` |', 'yes');
cfg = setRow(cfg, '| Autopilot worker concurrency |', '5 / 30');
cfg = setRow(cfg, '| Autopilot per-worker budget (USD) |', '25');
mkdirSync(join(CONFIG, 'repos', 'studia__studia-web'), { recursive: true });
writeFileSync(join(CONFIG, 'repos', 'studia__studia-web', 'config.md'), cfg);
// A repo folder whose config.md is missing.
mkdirSync(join(CONFIG, 'repos', 'studia__studia-zendesk'), { recursive: true });

// A desk-skills checkout: c47f43ab installed, origin/main two commits ahead.
const src = join(T, 'desk-skills');
const git = (...a) => spawnSync('git', ['-C', src, ...a], { encoding: 'utf8' }).stdout.trim();
mkdirSync(src, { recursive: true });
spawnSync('git', ['init', '-q', '-b', 'main', src]);
const commit = (n) => { writeFileSync(join(src, 'f.txt'), `${n}\n`); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', `c${n}`); return git('rev-parse', 'HEAD'); };
const installed = commit(1);
commit(2);
const head = commit(3);
git('update-ref', 'refs/remotes/origin/main', head);
writeFileSync(join(DESK_HOME, 'installed.json'), JSON.stringify({ commit: installed, at: '2026-11-15T09:58:00Z', from: src }));

const S = await import('../desk/bin/desk-ui-settings.mjs');
const { makeServer } = await import('../desk/bin/desk-ui.mjs');
let checkWord = { state: 'pending', word: 'in_progress' };
const checks = [];
const opened = [];
const PORT = await freePort();
const server = makeServer({ p: PORT, log: () => {}, settings: {
  check: (dir, sha) => { checks.push(sha); return checkWord; },
  updates: async () => S.countUpdates({ results: [{ name: 'context-audit', outdated: true }, { name: 'claude-statusline', outdated: true }, { name: 'ok-one', outdated: false }] },
    [{ plugin: 'vercel', status: 'outdated' }, { plugin: 'other', status: 'ok' }], '2026-11-27T08:00:00Z'),
  open: async (file) => { opened.push(file); return 0; },
  appEveryMs: 50,
  running: () => installed, // this server started on c47f43ab
} });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const call = (method, path, opts) => callPort(PORT, method, path, opts);
const ex = await call('POST', '/api/auth/exchange', { headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
const signed = { Cookie: String(ex.headers['set-cookie']).split(';')[0], 'X-Desk-Load': JSON.parse(ex.text).loadToken };
const get = async (path) => { const r = await call('GET', path, { headers: signed }); return r.status === 200 ? JSON.parse(r.text) : r.status; };

// ---- AC1-AC3: a repo's desk setup, read only
t('the settings routes need the window signed in', (await call('GET', '/api/settings/repos')).status, 401);
t('every repo folder is listed, with or without its config', await get('/api/settings/repos'),
  [{ slug: 'studia__studia-web', name: 'studia-web' }, { slug: 'studia__studia-zendesk', name: 'studia-zendesk' }]);
const web = await get('/api/settings/repos/studia__studia-web');
const row = (id) => web.rows.find((r) => r.id === id);
t('AC1 each row shows its value and meaning', [row('pr-merge-green'), row('pr-ready').value, row('concurrency').meaning, row('worker-budget').value],
  [{ group: 'Autonomy (§3)', id: 'pr-merge-green', label: 'Merge on green', value: 'ask', meaning: 'Desk asks you before each merge.', set: true }, 'yes', 'Up to 30 workers for this repo.', '$25']);
// Merge on green reads with autopilot-merge, as desk-env mergeGrant does.
const merge = (green, auto) => S.mergeMeaning(green, (id) => (id === 'pr-merge-green' ? green : auto));
t('Merge on green\'s meaning follows mergeGrant: both rows, and a batch\'s Stage 3 approval', [
  merge('yes', 'yes'), merge('yes', 'ask'), merge('ask', 'yes'), merge('ask', 'ask'), merge('yes', 'no'), merge('ask', 'no'), merge('no', 'yes'),
], [
  'Workers merge a PR once its checks pass.',
  'Workers merge on green only in a batch you approve merging for at Stage 3.',
  'Workers merge on green only in a batch you approve merging for at Stage 3; otherwise desk asks you before each merge.',
  'Workers merge on green only in a batch you approve merging for at Stage 3; otherwise desk asks you before each merge.',
  "A PR merges once its checks pass, in a session you run; workers leave theirs for you (autopilot-merge isn't yes).",
  'Desk asks you before each merge.',
  'A person merges each PR.',
]);
t('AC1 the Jira site row reads Not set, and why it matters', row('jira-site'),
  { group: 'People', id: 'jira-site', label: 'Jira site', value: 'Not set', meaning: "Desk can't use this until it's set.", set: false });
t('AC1 rows come in §9.3\'s groups, in order', [...new Set(web.rows.map((r) => r.group))], ['Autonomy (§3)', 'Capacity (§3b)', 'Spend', 'Checks (§4)', 'People']);
t('AC3 a missing desk setup says so and how to make one', await get('/api/settings/repos/studia__studia-zendesk'),
  { slug: 'studia__studia-zendesk', name: 'studia-zendesk', error: "Can't read studia-zendesk's desk setup (desk-config.md missing). Run /desk-setup to create it." });
t('a slug that is no repo folder is 404', [await get('/api/settings/repos/nope__nope'), await get('/api/settings/repos/..%2F..')], [404, 404]);
t('AC2 nothing here writes: a POST to a repo\'s settings is refused',
  (await call('POST', '/api/settings/repos/studia__studia-web', { headers: { ...signed, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{}' })).status, 405);

// ---- AC4: subscriptions
const logins = [
  { tool: 'claude', label: 'ben@studia.example', name: 'default', off: false, plan: 'Max 20x', default: true, pinned: [] },
  { tool: 'claude', label: 'ops@studia.example', name: 'work-2', off: false, plan: null, default: false, pinned: ['studia-web', 'ai-agents'] },
  { tool: 'claude', label: 'ben@personal.example', name: 'work-3', off: true, plan: null, default: false, pinned: [] },
  { tool: 'claude', label: 'spare@studia.example', name: 'work-4', off: false, plan: null, default: false, pinned: [] },
  { tool: 'codex', label: 'ben@studia.example', name: 'default', off: false, plan: 'Pro', default: true, pinned: [] },
];
const subs = S.subscriptionsView(logins, '~/.config/desk/subscriptions.md');
t('AC4 rows lead with each email, with the badges Default, Pinned · 2 repos and Off', subs.rows.map((r) => [r.email, r.badge]),
  [['ben@studia.example', 'Default'], ['ops@studia.example', 'Pinned · 2 repos'], ['ben@personal.example', 'Off'], ['spare@studia.example', 'Unused'], ['ben@studia.example', 'Default']]);
t('AC4 an off subscription says desk won\'t pick it', subs.rows[2].note, "desk won't pick it for new work.");
t('AC4 the pinned repos line', subs.pinned, ['studia-web and ai-agents run on ops@studia.example (work-2)']);
t('a default is Default even when off or pinned', S.badgeOf({ default: true, off: true, pinned: ['a'] }), 'Default');
writeFileSync(process.env.DESK_SUBSCRIPTIONS, '| Tool | Name | Folder | Rule |\n|---|---|---|---|\n| `claude` | `default` |\n');
const unreadable = await get('/api/settings/subscriptions');
t('§9.8 an unreadable subscriptions file gives desk\'s reason verbatim', [/^desk can't read .*subscriptions\.md: .*want 4 cells.*\. Fix those rows first\.$/.test(unreadable.error ?? '')], [true]);
writeFileSync(process.env.DESK_SUBSCRIPTIONS, '| Tool | Name | Folder | Rule |\n|---|---|---|---|\n| `claude` | `default` | `~/.claude` | `default` |\n');
const readable = await get('/api/settings/subscriptions');
t('a readable file lists its subscriptions with their badges', [readable.error, readable.rows?.map((r) => r.badge)], [undefined, ['Default']]);
t('usageViewJson carries each login\'s folder name and whether it is off', (await import('../desk/bin/desk-q-model.mjs')).usageViewJson([]).logins.map((l) => [l.name, l.off]), [['default', false]]);

// ---- AC5, AC6: the install
const inst = await get('/api/settings/install');
t('AC5 installed c47f43ab, main waiting on its tests check: the state line', inst.state,
  { glyph: '·', text: `· Waiting for main's tests check on ${head.slice(0, 8)}. desk installs it once the check passes.` });
t('the install and main, with main 2 commits ahead', [inst.checkout, inst.installed.commit, inst.main.commit, inst.main.ahead, inst.main.check], [src, installed, head, 2, 'pending']);
await server.updates();
t('AC6 3 skill and plugin updates are counted, in the background', (await get('/api/settings/install')).updates,
  { count: 3, names: ['context-audit', 'claude-statusline', 'plugin vercel'], at: '2026-11-27T08:00:00Z', partial: false });
t('a count that may be short says so: a side unread, a skill source that errored, a plugin it couldn\'t compare', [
  S.countUpdates(null, [], 'x').partial,
  S.countUpdates({ results: [] }, null, 'x').partial,
  S.countUpdates({ results: [{ name: 'a', outdated: true }], errors: [{ name: 'b', error: 'HTTP 502' }] }, [], 'x'),
  S.countUpdates({ results: [] }, [{ plugin: 'p', status: 'unknown' }], 'x').partial,
  S.countUpdates(null, null, 'x'),
], [true, true, { count: 1, names: ['a'], at: 'x', partial: true }, true, null]);
t('main\'s check is read once a minute, not on every request', checks.length, 1);
t('the other state lines', [
  S.stateLine({ installed: head, head }).text,
  S.stateLine({ installed, head, check: { state: 'failure' } }).text,
  S.stateLine({ installed, head, check: { error: 'gh: HTTP 502' } }).text,
  S.stateLine({ installed, head, check: { state: 'pending' }, release: { blocked: { sha: head, why: '~/studia/desk-skills has uncommitted changes, so nothing was pulled or installed' } } }).text,
  S.stateLine({ installed, head, check: { state: 'success' }, release: { waiting: { base: installed, passes: { a: 1 } } } }).text,
  S.stateLine({ installed, head, check: { state: 'success' }, release: { waiting: { base: head, passes: { a: 1 } } } }).text,
  S.stateLine({ installed, head, check: { state: 'success' }, windowOpen: true }).text,
], [
  `✓ Up to date. Installed ${head.slice(0, 8)} is GitHub main.`,
  `✕ main's tests check failed on ${head.slice(0, 8)}, not installing. You stay on ${installed.slice(0, 8)} until a newer commit passes.`,
  `· Waiting for main's tests check on ${head.slice(0, 8)}. desk installs it once the check passes.`,
  `✕ Not installing ${head.slice(0, 8)}: ~/studia/desk-skills has uncommitted changes, so nothing was pulled or installed.`,
  `· Waiting: a worker is opening its PR. ${head.slice(0, 8)} passed its tests check. desk installs it once no worker is opening a PR.`,
  `· ${head.slice(0, 8)} passed its tests check. desk installs it at the next pass.`,
  '· Waiting: the maintenance window is open. desk checks GitHub main again when it closes.',
]);
mkdirSync(join(T, 'maint'), { recursive: true });
writeFileSync(join(T, 'maint', 'maintenance.json'), JSON.stringify({ phase: 'draining' }));
t('an open maintenance window holds the install view\'s state line', (await S.installView({ check: async () => ({ state: 'success' }), release: {} })).state.text,
  '· Waiting: the maintenance window is open. desk checks GitHub main again when it closes.');
writeFileSync(join(T, 'maint', 'maintenance.json'), JSON.stringify({ phase: 'done' }));

const unread = await S.installView({ check: async () => ({ error: 'gh: HTTP 502' }), release: {} });
t('a check it couldn\'t read is waited on, as the release waits on it', [unread.main.check, unread.state.glyph], ['pending', '·']);
const none = await S.installView({ check: async () => null, release: {} });
t('a check with no answer yet is waited on, never read as passed', [none.main.check, none.state.text],
  ['pending', `· Waiting for main's tests check on ${head.slice(0, 8)}. desk installs it once the check passes.`]);

// A request waiting on one commit's check gets that commit's answer, though main moves on meanwhile.
let answer;
checkWord = new Promise((r) => { answer = r; });
const third = commit(4);
git('update-ref', 'refs/remotes/origin/main', third);
const slow = get('/api/settings/install');
for (let i = 0; i < 80 && !checks.includes(third); i++) await sleep(25);
checkWord = { state: 'pending', word: 'queued' };
const fourth = commit(5);
git('update-ref', 'refs/remotes/origin/main', fourth);
const quick = await get('/api/settings/install');
answer({ state: 'failure', word: 'failure' });
const late = await slow;
t('each request reads its own commit\'s check, not the one that replaced it', [late.main.commit, late.main.check, late.state.glyph, quick.main.commit, quick.main.check],
  [third, 'failure', '✕', fourth, 'pending']);

// ---- AC7, AC9, AC11, AC12: the app build and the installed commit, on the change stream
const meta0 = await get('/api/meta');
t('/api/meta carries the app build and the installed commit', [meta0.app, meta0.installed], [{ build: null, failed: null }, installed]);
const heard = [];
server.feed.announce = ((orig) => (event, data) => { heard.push([event, data]); orig(event, data); })(server.feed.announce);
mkdirSync(join(DESK_HOME, 'ui'), { recursive: true });
writeFileSync(join(DESK_HOME, 'ui', 'source-hash'), 'abc123\n');
for (let i = 0; i < 40 && !heard.length; i++) await sleep(25);
t('AC7 a new app build is a server event naming it', heard.map(([e, d]) => [e, d.app]), [['server', { build: 'abc123', failed: null }]]);
writeFileSync(join(DESK_HOME, 'ui', 'build-failed'), 'def456\n');
for (let i = 0; i < 40 && heard.length < 2; i++) await sleep(25);
t('AC11 a build that failed is a server event, and /api/meta says so on the next load', [heard[1]?.[1].app, (await get('/api/meta')).app],
  [{ build: 'abc123', failed: 'def456' }, { build: 'abc123', failed: 'def456' }]);
writeFileSync(join(DESK_HOME, 'installed.json'), JSON.stringify({ commit: head, at: '2026-11-27T10:12:00Z', from: src }));
for (let i = 0; i < 40 && heard.length < 3; i++) await sleep(25);
t('AC12 a release installed is a server event with its commits', [heard[2]?.[1].installed, heard[2]?.[1].released], [head, { from: installed, commits: 2 }]);
t('AC9 the server, stopped after an update, says it is restarting', [server.restarting(), heard.at(-1)?.[1].restarting], [undefined, true]);
const n = heard.length;
writeFileSync(join(DESK_HOME, 'installed.json'), JSON.stringify({ commit: installed, at: '2026-11-27T10:12:00Z', from: src }));
for (let i = 0; i < 40 && heard.length === n; i++) await sleep(25);
t('a move back to an older commit is no release: no toast', [heard.length > n, heard.at(-1)?.[1].installed, heard.at(-1)?.[1].released], [true, installed, undefined]);
heard.length = 0;
t('a server stopped on the code it runs says nothing', [server.restarting(), heard.length], [undefined, 0]);
// A commit off main: installed, then moved from to a commit on main. Neither move is a release.
const side = git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', `${installed}^{tree}`, '-p', installed, '-m', 'side');
writeFileSync(join(DESK_HOME, 'installed.json'), JSON.stringify({ commit: side, at: '2026-11-27T10:20:00Z', from: src }));
for (let i = 0; i < 40 && heard.length < 1; i++) await sleep(25);
writeFileSync(join(DESK_HOME, 'installed.json'), JSON.stringify({ commit: head, at: '2026-11-27T10:21:00Z', from: src }));
for (let i = 0; i < 40 && heard.length < 2; i++) await sleep(25);
t('a move off main, or back from off it, is no release: no toast', heard.map(([, d]) => [d.installed, d.released]), [[side, undefined], [head, undefined]]);

// ---- AC11 Open install log
const openLog = () => call('POST', '/api/settings/install-log', { headers: { ...signed, Origin: ORIGIN } });
t('no log yet is 404 and opens nothing', [(await openLog()).status, opened.length], [404, 0]);
mkdirSync(join(HOME, '.desk-autopilot', 'ui'), { recursive: true });
writeFileSync(join(HOME, '.desk-autopilot', 'ui', 'desk-ui-build.log'), 'npm ERR!\n');
const o = await openLog();
t('Open install log opens the app build\'s log, and only it', [o.status, opened], [200, [join(HOME, '.desk-autopilot', 'ui', 'desk-ui-build.log')]]);
t('a GET does not open it', (await call('GET', '/api/settings/install-log', { headers: signed })).status, 405);
t('it is audited', readFileSync(join(HOME, '.desk-autopilot', 'ui', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((e) => [e.route, e.argv]),
  [['/api/settings/install-log', ['open', '~/.desk-autopilot/ui/desk-ui-build.log']]]);

// ---- AC14, AC15: the app's own preferences file (Desk.app's main process)
const { readPrefs, writePrefs } = await import('../desk/shell/app.mjs');
const prefsFile = join(T, 'userData', 'preferences.json');
// The window shows nothing read as System and Comfortable (settings.test.jsx AC15).
t('AC15 a missing preferences file reads as nothing, with no error', readPrefs(prefsFile), {});
mkdirSync(dirname(prefsFile), { recursive: true });
writeFileSync(prefsFile, '{not json');
t('AC15 an unreadable one reads as nothing too', readPrefs(prefsFile), {});
writeFileSync(prefsFile, JSON.stringify({ theme: 42, density: 'compact', path: '/etc' }));
t('a value that is not a word, or a key it does not keep, is dropped', readPrefs(prefsFile), { density: 'compact' });
const auditBefore = readFileSync(join(HOME, '.desk-autopilot', 'ui', 'audit.jsonl'), 'utf8');
t('AC14 Theme Dark is written to the app\'s own file', [writePrefs(prefsFile, { theme: 'dark' }), JSON.parse(readFileSync(prefsFile, 'utf8'))],
  [{ density: 'compact', theme: 'dark' }, { density: 'compact', theme: 'dark' }]);
t('AC14 and no desk command ran for it', readFileSync(join(HOME, '.desk-autopilot', 'ui', 'audit.jsonl'), 'utf8'), auditBefore);
t('a key it does not keep, or a value that is not a word, writes nothing',
  [writePrefs(prefsFile, { theme: '../../etc' }), writePrefs(prefsFile, { theme: 'x'.repeat(40) }), writePrefs(prefsFile, { path: 'etc' }), writePrefs(prefsFile, null), JSON.parse(readFileSync(prefsFile, 'utf8')).theme],
  [null, null, null, null, 'dark']);
// The IPC handlers, through createShell with a stubbed Electron.
const ipc = {};
const { createShell } = await import('../desk/shell/app.mjs');
const fakeWin = { webContents: { id: 1, on() {}, setWindowOpenHandler() {} }, on() {}, loadURL() {}, loadFile() {}, isMinimized: () => false, show() {}, focus() {} };
createShell({ BrowserWindow: function W() { return fakeWin; }, ipcMain: { handle: (n, fn) => { ipc[n] = fn; } }, app: { getPath: () => join(T, 'userData2') },
  session: { fromPartition: () => ({ webRequest: { onBeforeSendHeaders() {}, onCompleted() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, cookies: { set: async () => {} } }) } },
{ origin: ORIGIN, token: () => null, probe: async () => null, watch: () => {}, setTimer: () => 0, clearTimer: () => {} }).open();
const page = { sender: fakeWin.webContents, senderFrame: { url: `${ORIGIN}/` } };
t('the window reads nothing before anything is saved', await ipc['desk:prefs-get'](page), {});
t('the window saves a theme to userData/preferences.json', [await ipc['desk:prefs-set'](page, { theme: 'dark' }), JSON.parse(readFileSync(join(T, 'userData2', 'preferences.json'), 'utf8')).theme], [{ theme: 'dark' }, 'dark']);
t('another page can neither read nor save them', [await ipc['desk:prefs-get']({ sender: {}, senderFrame: { url: `${ORIGIN}/` } }), await ipc['desk:prefs-set']({ sender: fakeWin.webContents, senderFrame: { url: 'https://evil.example/' } }, { theme: 'light' })], [null, false]);

server.close();
process.exit(fails ? 1 : 0);
