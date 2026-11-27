// suite: desk-q Usage view with Claude accounts pinned to folders (DS-528: DS-532, DS-533)
// layer: L2
// desk-q's view 6 against a subscriptions file whose Claude rows carry an Account, each Claude folder's
// .claude.json and probe log, and each Codex login's auth.json, on a fixed clock, under a throwaway HOME,
// DESK_HOME, DESK_CONFIG_ROOT, DESK_LOCK_DIR and DESK_USAGE_DIR, with fake claude and codex binaries the
// account check calls. Drawn at 104 columns under NO_COLOR. One check or more per acceptance criterion of
// DS-533 (one row per account, the wrong-account, not signed in and not set up rows, desk-q's own migrate
// and pin) and DS-532 (the Codex row named by its id_token's email and plan).
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('desk-q-usage-accounts-');
const H = join(T, 'home');
mkdirSync(join(T, 'bin'));
writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
// A folder holding .signed-out is signed out; a Claude one signed in says the email its .claude.json records.
writeFileSync(join(T, 'bin', 'claude'), `#!/bin/sh
d="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if [ -f "$d/.signed-out" ]; then echo '{"loggedIn": false}'; exit 1; fi
echo '{"loggedIn": true}'
`, { mode: 0o755 });
writeFileSync(join(T, 'bin', 'codex'), '#!/bin/sh\nd="${CODEX_HOME:-$HOME/.codex}"\n[ -f "$d/.signed-out" ] && exit 1\necho "Logged in"\n', { mode: 0o755 });
const env = { HOME: H, DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_LOCK_DIR: join(T, 'locks'), DESK_USAGE_DIR: join(T, 'usage'), DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'), DESK_PLATFORM: 'darwin',
  DESK_SKILLS_DIR: join(T, 'skills'), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH', 'DESK_BATCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'COLORFGBG', 'COLORTERM', 'NO_COLOR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DESK_AUTOPILOT_WORKER']) delete process.env[k];
Object.assign(process.env, env);
const WORK = join(H, '.claude-logins', 'work'), SPARE = join(H, '.claude-logins', 'spare'), ALT = join(H, '.codex-logins', 'alt');
for (const d of [env.DESK_LOCK_DIR, env.DESK_USAGE_DIR, join(H, '.claude'), WORK, SPARE, join(H, '.codex'), ALT]) mkdirSync(d, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
// Each Claude login's account as its .claude.json records it; the default's is ~/.claude.json.
const account = (path, email, plan) => writeFileSync(path, JSON.stringify({ oauthAccount: { emailAddress: email, planDisplayName: plan } }));
account(join(H, '.claude.json'), 'me@example.test', 'Ultra');
account(join(WORK, '.claude.json'), 'work@example.test', 'Max 5x');
account(join(SPARE, '.claude.json'), 'spare@example.test', 'Pro');

// Saturday 24 October 2026, 09:00 local.
const FIXED = new Date(2026, 9, 24, 9, 0).getTime();
const at = (d, h, m) => Math.round(new Date(2026, 9, d, h, m).getTime() / 1000);
const MIN = 60000;

function repo(benched = {}) {
  const slug = 'acme__solo';
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `3100` |\n| Autopilot worker concurrency | `2 / 3` | `2 / 3` |\n');
  const q = join(env.DESK_HOME, 'repos', slug, 'queue.json');
  mkdirSync(dirname(q), { recursive: true });
  writeFileSync(q, JSON.stringify({ version: 1, batch: 'solo', concurrency: 2, tickets: { 'S-1': { key: 'S-1', state: 'triaged' } }, benched }));
}
// Rows of five cells (Tool, Name, Folder, Account, Rule) write a file with account pins; of four, one without.
const subscriptions = (rows) => {
  const pinned = rows.some((r) => r.length === 5);
  const cells = (r) => (pinned && r.length === 4 ? [...r.slice(0, 3), '-', r[3]] : r);
  writeFileSync(env.DESK_SUBSCRIPTIONS, `${pinned ? '| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|' : '| Tool | Name | Folder | Rule |\n|---|---|---|---|'}\n`
    + `${rows.map((r) => `| ${cells(r).map((c) => `\`${c}\``).join(' | ')} |`).join('\n')}\n`);
};
// Three Claude accounts, each pinned to its own folder (spare found, not listed, until desk-q pins it).
const PERSONAL = ['claude', 'personal', '~/.claude', 'default'], CODEXMAIN = ['codex', 'codexmain', '~/.codex', 'default'];
const ROWS = [['claude', 'home', '~/.claude-logins/home', 'me@example.test', 'default'], ['claude', 'work', '~/.claude-logins/work', 'work@example.test', 'unused'],
  CODEXMAIN, ['codex', 'alt', '~/.codex-logins/alt', 'unused']];
const SPARE_ROW = ['claude', 'spare', '~/.claude-logins/spare', 'spare@example.test', 'unused'];

// A Claude login's probe log holding one reading, written `ago` before FIXED.
function claudeReading(key, five, seven, ago = MIN) {
  const path = join(env.DESK_USAGE_DIR, key ? `probe.${key}.log` : 'probe.log');
  writeFileSync(path, `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: five[0], resetsAt: five[1] }, seven_day: { utilization: seven[0], resetsAt: seven[1] } } } })}\n`);
  utimesSync(path, (FIXED - ago) / 1000, (FIXED - ago) / 1000);
}
claudeReading('home', [0.31, at(24, 14, 5)], [0.61, at(27, 6, 0)]);
claudeReading('work', [0.58, at(24, 13, 20)], [0.72, at(26, 9, 0)]);
claudeReading('spare', [0.0, at(24, 15, 0)], [0.18, at(29, 22, 0)], 30 * MIN);

// A Codex login's session log holding one token_count event; a window given as null is one the plan lacks.
function codexReading(dir, five, seven, plan = 'pro') {
  const logs = join(dir, 'sessions', '2026', '10', '24');
  rmSync(join(dir, 'sessions'), { recursive: true, force: true });
  mkdirSync(logs, { recursive: true });
  const w = (x, minutes) => (x ? { used_percent: x[0], window_minutes: minutes, resets_at: x[1] } : null);
  writeFileSync(join(logs, 'rollout-1.jsonl'), `${JSON.stringify({ timestamp: new Date(FIXED - 10 * MIN).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { primary: five ? w(five, 300) : w(seven, 10080), secondary: five ? w(seven, 10080) : null, plan_type: plan } } })}\n`);
}
codexReading(join(H, '.codex'), [16, at(24, 16, 40)], [27, at(26, 9, 0)]);
codexReading(ALT, [0, at(24, 12, 0)], [9, at(30, 18, 0)], 'plus');

const Q = await import(join(BIN, 'desk-q.mjs'));
const { PassThrough } = await import('node:stream');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const DOWN = '\x1b[B';

// desk-q open at 104 columns under NO_COLOR, its account check and rule keys running desk-env for real.
function open(start = { kind: 'overview', all: false }) {
  process.env.NO_COLOR = '1';
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = { buf: '', columns: 104, rows: 60, write(s) { this.buf += s; }, on() {}, removeListener() {} };
  const copied = [];
  const ui = Q.interactive({ input, output, start, exit() {}, refreshMs: 600000, clock: () => FIXED, probeMs: 600000, probeWith: async () => ({ ran: true }), copier: (s) => copied.push(s) });
  const frame = () => output.buf.split('\x1b[H').at(-1).split('\r\n').map((l) => plain(l.replace(/\x1b\[J$/, '').replace(/\x1b\[K$/, '')));
  const press = async (k) => { input.write(k); await sleep(20); };
  // Until `pred` holds of the frame, or 10 seconds.
  const until = async (pred) => { for (let i = 0; i < 500 && !pred(frame()); i++) await sleep(20); return frame(); };
  return { ui, frame, press, until, copied, done() { ui.finish(0); delete process.env.NO_COLOR; } };
}
// A table row: its name cell is padded, so the name is followed by two spaces, unlike a footer line.
const rowOf = (f, name) => f.find((l) => l.slice(2).startsWith(`${name}  `)) ?? null;
// The rows of the CLAUDE table, from its heading to the blank line after it.
const claudeRows = (f) => { const i = f.findIndex((l) => l.startsWith('  SUBSCRIPTION ')); return i < 0 ? [] : f.slice(i + 1, f.indexOf('', i)); };
const prose = (f) => f.join(' ').replace(/\s+/g, ' ');
// A row as the canvas lays it out: a 2-column lead, then NAME 25, PLAN 9, USE 14, 5H 21, 7D 25 and
// WORKERS 7 on the right. `windows` given alone is one cell across 5H and 7D.
const cellPad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
const row = (sel, name, plan, rule, h5, d7, w) => `${sel ? '›' : ' '} ${cellPad(name, 25)}${cellPad(plan, 9)}${cellPad(rule, 14)}${d7 == null ? cellPad(h5, 46) : cellPad(h5, 21) + cellPad(d7, 25)}${w.padStart(7)}`;
// The footer line, which can wrap onto the next.
const footer = (f, start) => { const i = f.findIndex((l) => l.startsWith(start)); return i < 0 ? null : f[i].length >= 100 ? `${f[i]} ${f[i + 1]}` : f[i]; };
const checked = (f) => !f.includes('Saving…');
const subsText = () => readFileSync(env.DESK_SUBSCRIPTIONS, 'utf8');
const deskEnv = (...args) => spawnSync(process.execPath, [join(BIN, 'desk-env.mjs'), 'logins', ...args], { encoding: 'utf8', env: process.env });

repo();


// ---- DS-533 AC17, AC18, AC19: an old file listing ~/.claude and a folder under ~/.claude-logins is
// migrated once, as desk-env logins migrate does, leaving ~/.claude's account to add with a
subscriptions([PERSONAL, ['claude', 'work', '~/.claude-logins/work', 'unused'], CODEXMAIN]);
const M = open();
await sleep(20);
await M.press('6');
let f = await M.until((x) => /\| Account \|/.test(subsText()) && prose(x).includes('Press a to add it again.') && prose(x).includes('moved to Removed'));
const TODAY = (() => { const d = new Date(); return { ymd: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  text: `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getFullYear()}` }; })();
t('DS-533 AC17 desk-q migrates the old file: work is pinned to its account and keeps its word', /^\| `claude` \| `work` \| `~\/.claude-logins\/work` \| `work@example.test` \| `unused` \|$/m.test(subsText()), true);
t('DS-533 AC17 AC19 and the found spare is pinned, unused', /^\| `claude` \| `spare` \| `~\/.claude-logins\/spare` \| `spare@example.test` \| `unused` \|$/m.test(subsText()), true);
t('DS-533 AC17 #1489 ~/.claude goes to the Removed table, dated today', subsText().includes(`| \`claude\` | \`personal\` | \`~/.claude\` | \`${TODAY.ymd}\` |`), true);
t('DS-533 AC17 once: the file has one Account column', subsText().split('| Account |').length, 2);
t('#1489 AC1 desk-q says ~/.claude moved, as the migration printed it', prose(f).includes('claude personal (~/.claude) moved to Removed: once a Claude login is pinned to an account'), true);
t('#1489 AC2 desk-q shows the migration\'s before and after for ~/.claude, and its dated backup', `${/claude personal \(~\/\.claude\): \S+ -> Removed/.test(prose(f))} ${prose(f).includes('(previous copy: ')}`, 'true true');
t('DS-533 AC18 #1489 AC3 the footer says ~/.claude\'s account was removed, and when', prose(f).includes(`me@example.test was removed from desk's accounts on ${TODAY.text}, when accounts were pinned. Press a to add it again.`), true);
t('#1489 AC3 and never that it was not added', prose(f).includes('isn\'t one of desk\'s accounts yet'), false);
t('DS-533 AC2 no row for ~/.claude', `${rowOf(f, 'me@example.test')} ${rowOf(f, 'personal')} ${rowOf(f, 'default')}`, 'null null null');
M.done();

// From here, three accounts each pinned to a folder.
const HOMEL = join(H, '.claude-logins', 'home');
mkdirSync(HOMEL, { recursive: true });
account(join(HOMEL, '.claude.json'), 'me@example.test', 'Ultra');
const ROWS3 = [ROWS[0], ROWS[1], SPARE_ROW, ROWS[2], ROWS[3]];
subscriptions(ROWS3);

// ---- DS-533 AC1, AC12, AC13: one row per account, labelled by its pin; the footer says desk's sign-ins are its own
const S = open();
await sleep(20);
await S.press('6');
f = await S.until((x) => !!rowOf(x, 'spare@example.test') && x.some((l) => l.includes('signs in for desk through')));
t('DS-533 AC1 the Claude table has exactly the three accounts', claudeRows(f).map((l) => l.slice(2, 27).trim()).join(', '),
  'me@example.test, work@example.test, spare@example.test');
t('DS-533 AC1 the default reads ◉ default under its pinned email', rowOf(f, 'me@example.test'),
  row(1, 'me@example.test', 'Ultra', '◉ default', '███······· 31% 14:05', '██████···· 61% Tue 06:00', '0'));
t('DS-533 AC12 the footer says desk\'s sign-ins are its own', f.some((l) => l.trim() === 'Desk keeps its own sign-ins, so switching account in your own Claude Code changes nothing here.'), true);
t('DS-533 AC13 and names the selected account\'s folder', f.some((l) => l.trim() === 'me@example.test signs in for desk through ~/.claude-logins/home.'), true);
t('DS-533 AC18 ~/.claude\'s account is pinned, so nothing offers to add it', f.some((l) => l.includes('Press a to add it.')), false);
t('DS-533 AC11 a signed-in row selected: no y in the keys', f.at(-1).includes('y copy command'), false);
S.done();

// ---- DS-533: one folder switched to another account and one signed out, with ~/.claude on an account
// none is pinned to: each row says why desk won't use it, and its note how to fix it
const headline = (fr) => fr.slice(3, fr.indexOf('', 3)).join(' ');
const ACCOUNTS = 'me@example.test, work@example.test, spare@example.test';
const names = (fr) => claudeRows(fr).map((l) => l.slice(2, 27).trim()).join(', ');
account(join(SPARE, '.claude.json'), 'work@example.test', 'Max 5x');
writeFileSync(join(WORK, '.signed-out'), '');
account(join(H, '.claude.json'), 'own@example.test', 'Pro');
const D = open();
await sleep(20);
await D.press('6');
f = await D.until((x) => x.some((l) => l.includes('◆ wrong account')));
t('DS-533 AC2 ~/.claude on another account: the same three rows, none for ~/.claude', names(f), ACCOUNTS);
t('DS-533 AC3 the wrong-account row keeps its pinned email, PLAN —, one cell naming the account it is on', rowOf(f, 'spare@example.test'),
  row(0, 'spare@example.test', '—', '○ unused', '◆ on work@example.test: desk won\'t use it', null, '0'));
t('DS-533 AC4 its note says what happened and how to switch it back', prose(f).includes('◆ wrong account Desk\'s sign-in for spare@example.test is now on work@example.test, so desk counts that account once and has stopped using this one. To switch it back, run CLAUDE_CONFIG_DIR=~/.claude-logins/spare claude in another terminal, then type /login and sign in to spare@example.test. Press y to copy the command.'), true);
t('DS-533 AC6 the signed-out row: PLAN —, one cell saying it is not signed in, 0 workers', rowOf(f, 'work@example.test'),
  row(0, 'work@example.test', '—', '○ unused', '◆ not signed in: desk won\'t use it', null, '0'));
t('DS-533 AC7 its note gives the sign-in command', prose(f).includes('◆ sign in work@example.test isn\'t signed in for desk yet. In another terminal, run CLAUDE_CONFIG_DIR=~/.claude-logins/work claude, then type /login and sign in to work@example.test. Press y to copy the command.'), true);
t('DS-533 AC5 AC9 with both, the line under the tabs is the wrong-account one', headline(f),
  'spare@example.test\'s sign-in was switched to another account, so desk has stopped using it.');
t('DS-533 AC18 ~/.claude\'s account, pinned to no row, is offered to add', f.some((l) => l.trim() === 'own@example.test isn\'t one of desk\'s accounts yet. Press a to add it.'), true);
await D.press(DOWN); await D.press(DOWN);
f = D.frame();
t('DS-533 AC10 the wrong-account row selected: the keys offer y copy command', f.at(-1).includes('y copy command'), true);
t('DS-533 AC13 and the footer names its folder', f.some((l) => l.trim() === 'spare@example.test signs in for desk through ~/.claude-logins/spare.'), true);
await D.press('y');
t('DS-533 AC10 y copies the command that signs its folder in', D.copied.join('\n'), 'CLAUDE_CONFIG_DIR=~/.claude-logins/spare claude');
D.done();
account(join(SPARE, '.claude.json'), 'spare@example.test', 'Pro');
rmSync(join(WORK, '.signed-out'));

// ---- #1489 AC3: ~/.claude named by a Removed table from before its date column: removed, date unknown
subscriptions(ROWS3);
writeFileSync(env.DESK_SUBSCRIPTIONS, `${subsText()}\n## Removed\n\n| Tool | Name | Folder |\n|---|---|---|\n| \`claude\` | \`personal\` | \`~/.claude\` |\n`);
const R = open();
await sleep(20);
await R.press('6');
f = await R.until((x) => prose(x).includes('own@example.test was removed'));
t('#1489 AC3 an old Removed table: removed, with the date said to be unknown', prose(f).includes('own@example.test was removed from desk\'s accounts (the date was not recorded), when accounts were pinned. Press a to add it again.'), true);
R.done();
subscriptions(ROWS3);
account(join(H, '.claude.json'), 'me@example.test', 'Ultra');

// ---- DS-533 AC14, AC16: a folder desk could not pin is not set up, named by its folder
const L5 = join(H, '.claude-logins', 'login-5');
mkdirSync(L5, { recursive: true });
writeFileSync(join(L5, '.signed-out'), '');
const U = open();
await sleep(20);
await U.press('6');
f = await U.until((x) => (rowOf(x, 'login-5') ?? '').includes('◆ not set up'));
t('DS-533 AC14 its row is labelled by its folder, one cell saying it is not set up', rowOf(f, 'login-5'), row(0, 'login-5', '—', '○ unused', '◆ not set up: desk won\'t use it', null, '0'));
t('DS-533 AC14 its note says how to add it or remove it', prose(f).includes('◆ not set up login-5 isn\'t one of desk\'s accounts. To add it, run CLAUDE_CONFIG_DIR=~/.claude-logins/login-5 claude in another terminal, type /login, and sign in to an account desk doesn\'t have. Press y to copy the command, or x to remove it.'), true);
for (let i = 0; i < 3; i++) await U.press(DOWN);
t('DS-533 AC16 it is selected', U.frame().find((l) => l.startsWith('›'))?.slice(2, 9), 'login-5');
await U.press('y');
t('DS-533 AC16 y copies its sign-in command', U.copied.join('\n'), 'CLAUDE_CONFIG_DIR=~/.claude-logins/login-5 claude');
U.done();
// AC15: hand-pinned to the account work already has.
subscriptions([...ROWS3.slice(0, 3), ['claude', 'login-5', '~/.claude-logins/login-5', 'work@example.test', 'unused'], ...ROWS3.slice(3)]);
const U2 = open();
await sleep(20);
await U2.press('6');
f = await U2.until((x) => x.some((l) => l.includes('◆ not set up')) && !!rowOf(x, 'login-5'));
t('DS-533 AC15 a second folder pinned to one account: its note says whose', prose(f).includes('◆ not set up login-5 is pinned to the same account as work. To add it, run'), true);
t('DS-533 AC15 and its row is still named by its folder, work keeping the account', `${!!rowOf(f, 'login-5')} ${names(f).split(', ').filter((n) => n === 'work@example.test').length}`, 'true 1');
U2.done();
rmSync(L5, { recursive: true, force: true });
subscriptions(ROWS3);

// A pinned account whose folder is gone keeps its row, as not signed in, so its sign-in command is offered.
subscriptions([...ROWS3, ['claude', 'gone', '~/.claude-logins/gone', 'gone@example.test', 'unused']]);
const G = open();
await sleep(20);
await G.press('6');
const gf = await G.until((x) => rowOf(x, 'gone@example.test')?.includes('not signed in') ?? false);
t('a pinned account whose folder is gone keeps its row, not signed in', rowOf(gf, 'gone@example.test')?.includes('◆ not signed in: desk won\'t use it') ?? false, true);
t('and its note gives the command that signs it in', prose(gf).includes('CLAUDE_CONFIG_DIR=~/.claude-logins/gone claude'), true);
G.done();
subscriptions(ROWS3);

// ---- DS-533 AC21: one Claude login and one Codex login: nothing about accounts, the file left as it was
rmSync(join(H, '.claude-logins'), { recursive: true, force: true });
rmSync(join(H, '.codex-logins'), { recursive: true, force: true });
subscriptions([PERSONAL, CODEXMAIN]);
const One = open();
await sleep(20);
await One.press('6');
await One.until((x) => x.some((l) => l.startsWith('  Read at') || l.startsWith('  No login')) && !x.includes('Saving…'));
await sleep(200);
f = One.frame();
t('DS-533 AC21 one login: no reassurance line, nothing offered to add, the file left as it was',
  `${f.some((l) => l.includes('Desk keeps its own sign-ins'))} ${f.some((l) => l.includes('Press a to add it.'))} ${/\| Account \|/.test(subsText())}`, 'false false false');
One.done();

// ---- DS-532: a Codex row named by its auth.json id_token's email, with its plan title-cased
// Each auth.json is given its own mtime: the view reads one again only when that changes.
let authAt = FIXED / 1000;
const ACCESS = ['access', 'fixture0token0never0shown'].join('-'), REFRESH = ['refresh', 'fixture0token0never0shown'].join('-');
const idToken = (payload) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
const claim = (email, plan) => ({ ...(email ? { email } : {}), 'https://api.openai.com/auth': plan ? { chatgpt_plan_type: plan } : {} });
function auth(dir, body) {
  const path = join(dir, 'auth.json');
  if (body == null) rmSync(path, { force: true });
  else { writeFileSync(path, JSON.stringify(body)); authAt += 60; utimesSync(path, authAt, authAt); }
}
const signedIn = (idTok) => ({ OPENAI_API_KEY: null, tokens: { id_token: idTok, access_token: ACCESS, refresh_token: REFRESH, account_id: 'a' } });
const codexRow = async (name) => {
  const V = open();
  await sleep(20);
  await V.press('6');
  const fr = await V.until((x) => x.some((l) => l.includes('CODEX')));
  V.done();
  return { row: rowOf(fr, name), frame: fr.join('\n') };
};
const LEAD = (name, plan) => row(0, name, plan, '◉ default', '', '', '').slice(0, 50);
codexReading(join(H, '.codex'), null, [27, at(26, 9, 0)], 'self_serve');

auth(join(H, '.codex'), signedIn(idToken(claim('me@x.io', 'pro'))));
let v = await codexRow('me@x.io');
t('DS-532 AC1 the Codex row is labelled by its id_token\'s email and its PLAN is the plan type title-cased', v.row?.slice(0, 50), LEAD('me@x.io', 'Pro'));
t('DS-532 AC6 the session log\'s self_serve is not shown as the PLAN', v.frame.includes('self_serve'), false);
t('DS-532 AC9 neither the access nor the refresh token\'s text is in the frame', v.frame.includes(ACCESS) || v.frame.includes(REFRESH), false);

auth(join(H, '.codex'), signedIn(idToken(claim('me@x.io', null))));
t('DS-532 AC2 an id_token with no plan type: PLAN —', (await codexRow('me@x.io')).row?.slice(0, 50), LEAD('me@x.io', '—'));

auth(join(H, '.codex'), null);
v = await codexRow('codexmain');
t('DS-532 AC3 no auth.json: labelled by its name, PLAN —', v.row?.slice(0, 50), LEAD('codexmain', '—'));
t('DS-532 AC3 AC6 and self_serve is not shown in its place', v.frame.includes('self_serve'), false);
t('DS-532 AC3 and no error is shown', /auth\.json|error|could not/i.test(v.frame), false);
writeFileSync(join(H, '.codex', 'desk-label'), 'Main Codex\n');
t('DS-532 AC3 no auth.json: labelled by its desk label where it has one', (await codexRow('Main Codex'))?.row?.slice(0, 50), LEAD('Main Codex', '—'));
rmSync(join(H, '.codex', 'desk-label'));

auth(join(H, '.codex'), { OPENAI_API_KEY: ['sk', 'fixture0key0never0shown'].join('-'), tokens: null });
v = await codexRow('codexmain');
t('DS-532 AC4 an auth.json holding only an API key falls back as with none', v.row?.slice(0, 50), LEAD('codexmain', '—'));
t('DS-532 AC4 and the key is not in the frame', v.frame.includes('fixture0key0never0shown'), false);

auth(join(H, '.codex'), signedIn(`e30.${Buffer.from(JSON.stringify(claim('me@x.io', 'pro'))).toString('base64url')}`));
t('DS-532 AC5 an id_token of two parts falls back', (await codexRow('codexmain')).row?.slice(0, 50), LEAD('codexmain', '—'));
auth(join(H, '.codex'), signedIn('e30.!!not-json!!.sig'));
t('DS-532 AC5 an id_token whose middle part does not decode falls back', (await codexRow('codexmain')).row?.slice(0, 50), LEAD('codexmain', '—'));
auth(join(H, '.codex'), null);

// AC7: a Codex login whose CODEX_HOME is ~/.codex-work.
const CW = join(H, '.codex-work');
mkdirSync(CW, { recursive: true });
codexReading(CW, null, [9, at(30, 18, 0)], 'self_serve');
auth(CW, signedIn(idToken(claim('work@x.io', 'plus'))));
subscriptions([PERSONAL, ['codex', 'codexmain', '~/.codex', 'off'], ['codex', 'cw', '~/.codex-work', 'default']]);
v = await codexRow('work@x.io');
t('DS-532 AC7 a Codex login whose folder is ~/.codex-work is labelled by its own id_token\'s email', v.row?.slice(0, 50), row(0, 'work@x.io', 'Plus', '◉ default', '', '', '').slice(0, 50));

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all desk-q Usage accounts checks passed');
process.exit(fails ? 1 : 0);
