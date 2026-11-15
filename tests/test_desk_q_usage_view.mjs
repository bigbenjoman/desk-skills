// suite: desk-q Usage view (view 6: every Claude and Codex login with its plan, use and both windows)
// desk-q's view 6 against a subscriptions file, each Claude login's .claude.json and probe log, each Codex
// login's session logs, each repo's Subscription row and a queue's benched logins, on a fixed clock, under
// a throwaway HOME, DESK_HOME, DESK_CONFIG_ROOT, DESK_LOCK_DIR and DESK_USAGE_DIR, with fake claude and
// codex binaries the account check calls. The default, undo and remove keys run desk-env's logins
// commands. Drawn at 104 columns under NO_COLOR. One check or more per acceptance criterion of DS-472
// and DS-623.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-q-usage-view-'));
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
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'DESK_SUBSCRIPTION', 'COLORFGBG', 'COLORTERM', 'NO_COLOR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DESK_AUTOPILOT_WORKER']) delete process.env[k];
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

// A repo's config, its Subscription row naming `sub` when given; null drops the repo.
function config(slug, sub = null) {
  const dir = join(env.DESK_CONFIG_ROOT, 'repos', slug);
  if (sub === false) return rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.md'),
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`3100\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`2 / 3\` |\n${sub ? `| Subscription | \`default\` | \`${sub}\` |\n` : ''}`);
}
// The repo with a queue, solo: its Subscription row naming `sub` when given, and `running` workers on
// the default (a worker with no login file runs on it).
function repo(benched = {}, sub = null, running = 0) {
  const slug = 'acme__solo';
  config(slug, sub);
  const q = join(env.DESK_HOME, 'repos', slug, 'queue.json');
  mkdirSync(dirname(q), { recursive: true });
  const tickets = { 'S-1': { key: 'S-1', state: 'triaged' } };
  for (let i = 0; i < running; i++) tickets[`S-${i + 2}`] = { key: `S-${i + 2}`, state: 'running' };
  writeFileSync(q, JSON.stringify({ version: 1, batch: 'solo', concurrency: 2, tickets, benched }));
}
const subscriptions = (rows) => writeFileSync(env.DESK_SUBSCRIPTIONS,
  `| Tool | Name | Folder | Rule |\n|---|---|---|---|\n${rows.map((r) => `| ${r.map((c) => `\`${c}\``).join(' | ')} |`).join('\n')}\n`);
const ROWS = [['claude', 'personal', '~/.claude', 'default'], ['claude', 'work', '~/.claude-logins/work', 'unused'],
  ['codex', 'codexmain', '~/.codex', 'default'], ['codex', 'alt', '~/.codex-logins/alt', 'unused']];

// A Claude login's probe log holding one reading, written `ago` before FIXED.
function claudeReading(key, five, seven, ago = MIN) {
  const path = join(env.DESK_USAGE_DIR, key ? `probe.${key}.log` : 'probe.log');
  writeFileSync(path, `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: five[0], resetsAt: five[1] }, seven_day: { utilization: seven[0], resetsAt: seven[1] } } } })}\n`);
  utimesSync(path, (FIXED - ago) / 1000, (FIXED - ago) / 1000);
}
claudeReading(null, [0.31, at(24, 14, 5)], [0.61, at(27, 6, 0)]);
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

// desk-q open at `columns` (104) under NO_COLOR, its account check and keys running desk-env for real.
function open(start = { kind: 'overview', all: false }, columns = 104) {
  process.env.NO_COLOR = '1';
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = { buf: '', columns, rows: 60, write(s) { this.buf += s; }, on() {}, removeListener() {} };
  const copied = [];
  const ui = Q.interactive({ input, output, start, exit() {}, refreshMs: 600000, clock: () => FIXED, probeMs: 600000, probeWith: async () => ({ ran: true }), copier: (s) => copied.push(s) });
  const frame = () => output.buf.split('\x1b[H').at(-1).split('\r\n').map((l) => plain(l.replace(/\x1b\[J$/, '').replace(/\x1b\[K$/, '')));
  const press = async (k) => { input.write(k); await sleep(20); };
  // Until `pred` holds of the frame, or 10 seconds.
  const until = async (pred) => { for (let i = 0; i < 500 && !pred(frame()); i++) await sleep(20); return frame(); };
  // The selection moved down onto the row starting `name`.
  const pick = async (name) => { for (let i = 0; i < 8 && !frame().find((l) => l.startsWith('›'))?.slice(2).startsWith(`${name} `); i++) await press(DOWN); };
  return { ui, frame, press, until, pick, copied, done() { ui.finish(0); delete process.env.NO_COLOR; } };
}
// Usage open on its first frame after the account check.
async function usage(start, columns) {
  const u = open(start, columns);
  await sleep(20);
  await u.press('6');
  await u.until((x) => x.some((l) => l.startsWith('  Read at') || l.startsWith('  No login')));
  await sleep(150);
  return u;
}
const rowOf = (f, name) => f.find((l) => l.slice(2).startsWith(`${name} `)) ?? null;
// A row as the canvas lays it out: a 2-column lead, then NAME 25, PLAN 9, USE 14, 5H 21, 7D 25 and
// WORKERS 7 on the right. `windows` given alone is one cell across 5H and 7D.
const cellPad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
const row = (sel, name, plan, use, h5, d7, w) => `${sel ? '›' : ' '} ${cellPad(name, 25)}${cellPad(plan, 9)}${cellPad(use, 14)}${d7 == null ? cellPad(h5, 46) : cellPad(h5, 21) + cellPad(d7, 25)}${w.padStart(7)}`;
const useOf = (f, name) => rowOf(f, name)?.slice(36, 50).trimEnd() ?? null;
// The footer line, which can wrap onto the next.
const footer = (f, start) => { const i = f.findIndex((l) => l.startsWith(start)); return i < 0 ? null : f[i].length >= 100 ? `${f[i]} ${f[i + 1]}` : f[i]; };
const checked = (f) => !f.includes('Saving…');
const subsText = () => readFileSync(env.DESK_SUBSCRIPTIONS, 'utf8');
const ruleIn = (tool, name) => (new RegExp(`^\\| \`${tool}\` \\| \`${name}\` \\| [^|]+ \\| \`([^\`]+)\` \\|$`, 'm').exec(subsText()) ?? [])[1];
const deskEnv = (...args) => spawnSync(process.execPath, [join(BIN, 'desk-env.mjs'), 'logins', ...args], { encoding: 'utf8', env: process.env });

// solo and api follow the default, web is pinned to work; two workers run on the default.
repo({}, null, 2);
config('acme__api');
config('acme__web', 'work@example.test');
subscriptions(ROWS);

// ---- DS-472 AC1: 6 opens Usage
let S = open();
await sleep(20);
await S.press('6');
let f = S.frame();
t('DS-472 AC1 6 opens the Usage view, its tab highlighted', `${f[0].replace(/ · \d\d:\d\d$/, '')} | ${f[1]}`, 'desk-q | 1 Queue  2 Timeline  3 By day  4 Epics  5 Costs  6 Usage');
S.done();

// ---- AC1, AC3, AC8, AC12, AC14: the tables, the headline and the keys
S = await usage();
f = S.frame();
const HEAD = '  SUBSCRIPTION             PLAN     USE           5H                   7D                       WORKERS';
t('AC1 the Claude table\'s columns are SUBSCRIPTION, PLAN, USE, 5H, 7D and WORKERS', f.includes(HEAD), true);
t('AC1 the default reads ◉ default, with its plan, both windows and its 2 workers', rowOf(f, 'me@example.test'),
  row(1, 'me@example.test', 'Ultra', '◉ default', '███······· 31% 14:05', '██████···· 61% Tue 06:00', '2'));
t('AC1 a subscription one repo is pinned to reads ● 1 repo', rowOf(f, 'work@example.test'),
  row(0, 'work@example.test', 'Max 5x', '● 1 repo', '██████···· 58% 13:20', '███████··· 72% Mon 09:00', '0'));
t('AC1 a subscription no repo runs on reads ○ unused', rowOf(f, 'spare@example.test'),
  row(0, 'spare@example.test', 'Pro', '○ unused', '·········· 0% 15:00', '██········ 18% Thu 22:00', '0'));
t('the Codex table keeps its layout, with USE in place of RULE', f.includes('  CODEX                    PLAN     USE           5H                   7D                       WORKERS'), true);
t('AC12 the Codex default reads ◉ default', rowOf(f, 'codexmain'), row(0, 'codexmain', 'pro', '◉ default', '██········ 16% 16:40', '███······· 27% Mon 09:00', '—'));
t('AC12 the other Codex login reads ○ unused', rowOf(f, 'alt'), row(0, 'alt', 'plus', '○ unused', '·········· 0% 12:00', '█········· 9% Fri 18:00', '—'));
t('AC3 the headline names the default and says pinned repos run elsewhere', f[3], "Workers run on me@example.test, this computer's default, unless their repo is pinned.");
t('AC8 a subscription row selected: the keys offer d, a, x, : and q', f.at(-1), '↑↓ select · ←→ or 1–6 view · d make default · a add · x remove · : command · q quit');
const rotation = /in rotation|standby|○ standby|◌ off|new workers start on the one with most room/;
t('AC14 no rotation rule, legend or standby appears', f.some((l) => rotation.test(l)), false);
S.done();
// AC8 where the keys go on two lines, the act line reads as the canvas has it.
S = await usage(undefined, 72);
f = S.frame();
t('AC8 the act line, where the keys wrap', f.at(-1), 'act   d make default · a add · x remove · : command · q quit');
t('AC8 and the move line above it', f.at(-2), 'move  ↑↓ select · ←→ or 1–6 view');
S.done();

// ---- AC2: two repos pinned to one subscription
config('acme__site', 'work@example.test');
S = await usage();
t('AC2 two repos pinned: ● 2 repos', useOf(S.frame(), 'work@example.test'), '● 2 repos');
S.done();
config('acme__site', false);

// ---- AC18, AC7, AC9, AC10: space changes nothing, d on the default changes nothing, x is refused
S = await usage();
let before = subsText();
await S.press(' ');
await sleep(200);
t('AC18 space on a subscription row changes no rule and leaves the file as it was', subsText(), before);
await S.press('d');
await sleep(200);
t('AC7 d on the default leaves the subscriptions file unchanged', subsText(), before);
t('AC7 and says it is already the default', S.frame().includes('me@example.test is already the default.'), true);
await S.press('x');
await sleep(200);
t('AC9 x on the default does not remove it', subsText(), before);
t('AC9 and the message says to make another the default first', S.frame().includes('me@example.test is the default. Make another subscription the default with d first.'), true);
await S.pick('work@example.test');
await S.press('x');
await sleep(200);
t('AC10 x on a subscription a repo is pinned to does not remove it', subsText(), before);
t('AC10 and the message names the repo to move first', S.frame().includes('work@example.test runs web. Move web to another subscription first.'), true);

// ---- AC5, AC6: d makes the selected subscription the default at once, and u undoes
await S.press('d');
f = await S.until((x) => checked(x) && x.some((l) => l.startsWith('✓')));
t('AC5 d: work is the default in the file, the old default unused', `${ruleIn('claude', 'work')} ${ruleIn('claude', 'personal')}`, 'default unused');
const said = f.findIndex((l) => l.startsWith('✓'));
t('AC5 the first message line names the new default and the repos following it', f[said], '✓ work@example.test is now the default. api and solo follow it from their next worker.');
t('AC5 the second says where running workers finish, and that u undoes', f[said + 1], '  2 running workers finish on me@example.test. u undoes.');
t('AC5 no confirmation was asked: the view shows work as the default', `${useOf(f, 'work@example.test')} | ${useOf(f, 'me@example.test')}`, '◉ default | ○ unused');
t('AC5 the headline names the new default', f[3], "Workers run on work@example.test, this computer's default, unless their repo is pinned.");
t('AC5 the keys offer u', f.at(-1), '↑↓ select · ←→ or 1–6 view · d make default · a add · x remove · u undo · : command · q quit');
await S.press('u');
f = await S.until((x) => checked(x) && x.some((l) => l.includes('is the default again')));
t('AC6 u: the old default is the default again in the file', `${ruleIn('claude', 'personal')} ${ruleIn('claude', 'work')}`, 'default unused');
t('AC6 and in view 6', `${useOf(f, 'me@example.test')} | ${useOf(f, 'work@example.test')}`, '◉ default | ● 1 repo');
t('AC6 the message says so', f.includes('me@example.test is the default again.'), true);
await S.press('u');
t('u with nothing to undo says so', S.frame().includes('Nothing to undo.'), true);

// ---- AC13: d on a Codex login changes the Codex default only
await S.pick('alt');
await S.press('d');
f = await S.until((x) => checked(x) && x.some((l) => l.startsWith('✓')));
t('AC13 d on codex alt makes it the Codex default, the Claude default unchanged',
  `${ruleIn('codex', 'alt')} ${ruleIn('codex', 'codexmain')} ${ruleIn('claude', 'personal')}`, 'default unused default');
t('AC13 the message names it the Codex default', f[f.findIndex((l) => l.startsWith('✓'))], '✓ alt is now the Codex default.');
t('AC13 and the view shows it', `${useOf(f, 'alt')} | ${useOf(f, 'codexmain')} | ${useOf(f, 'me@example.test')}`, '◉ default | ○ unused | ◉ default');
S.done();
subscriptions(ROWS);

// ---- DS-472 AC10, AC11, AC15: a signed-out login says so, the headline too, and y copies its sign-in command
writeFileSync(join(SPARE, '.signed-out'), '');
const O = open({ kind: 'overview', all: false });
await sleep(20);
await O.press('6');
f = await O.until((x) => x.some((l) => l.includes('signed out')));
t('DS-472 AC10 a signed-out login says it is signed out and desk will not use it', rowOf(f, 'spare@example.test'),
  row(0, 'spare@example.test', 'Pro', '○ unused', '◆ signed out: desk won\'t use it', null, '0'));
t('AC15 the headline says it isn\'t signed in, naming no login workers start on', f[3], "spare@example.test isn't signed in yet, so desk can't use it.");
t('DS-472 AC10 a note says how to sign it back in', f.find((l) => l.startsWith('note  ◆ sign in')),
  'note  ◆ sign in      spare@example.test is signed out. Sign it back in, in another terminal:');
await O.pick('spare@example.test');
t('DS-472 AC11 with it selected, the keys offer y', O.frame().at(-1).includes('y copy the sign-in command'), true);
await O.press('d');
await sleep(200);
t('d on a signed-out login is refused, the file unchanged', `${ruleIn('claude', 'personal')} ${O.frame().includes("spare@example.test isn't signed in yet, so it can't be the default. Sign it in first.")}`, 'default true');
await O.press('y');
t('DS-472 AC11 y copies its sign-in command to the clipboard', O.copied.join('\n'), 'CLAUDE_CONFIG_DIR=~/.claude-logins/spare claude');
t('DS-472 AC11 and the footer says so', footer(O.frame(), 'Copied'), 'Copied the sign-in command: CLAUDE_CONFIG_DIR=~/.claude-logins/spare claude. Run it in another terminal, then /login.');
await O.press(DOWN);
await O.press('y');
t('y on a signed-in login copies nothing and says why', `${O.copied.length} ${O.frame().some((l) => l.startsWith('codexmain is signed in, so there is no sign-in command to copy.'))}`, '1 true');
rmSync(join(SPARE, '.signed-out'));

// ---- DS-472 AC9, AC17: x removes an unused login, leaving its folder and sign-in
await O.press('\x1b[A');
t('x acts on the selected login', O.frame().find((l) => l.startsWith('›'))?.slice(2, 20), 'spare@example.test');
await O.press('x');
f = await O.until(checked);
t('DS-472 AC9 x removes the login, and the footer says its folder and sign-in stay', footer(f, 'spare@example.test is removed'),
  'spare@example.test is removed from the rules for this computer. Its folder and sign-in are left as they are. u undoes.');
t('DS-472 AC9 its folder and sign-in are left as they are', `${existsSync(SPARE)} ${existsSync(join(SPARE, '.claude.json'))}`, 'true true');
t('DS-472 AC9 the file names it as removed', /^\| `claude` \| `spare` \| `~\/.claude-logins\/spare` \|$/m.test(subsText()), true);
t('DS-472 AC9 the view no longer lists it', rowOf(f, 'spare@example.test'), null);
const check17 = JSON.parse(deskEnv('check', '--json').stdout);
t('DS-472 AC17 the next account check does not list it again', check17.logins.some((l) => l.name === 'spare'), false);
await O.press('u');
f = await O.until((x) => checked(x) && x.some((l) => l.includes('is back')));
t('u after x lists it again, unused', `${ruleIn('claude', 'spare')} ${/^\| `claude` \| `spare` \| `~\/.claude-logins\/spare` \|$/m.test(subsText())}`, 'unused false');
t('and the view shows it unused', useOf(f, 'spare@example.test'), '○ unused');
O.done();
// A worker's deny rules match on the command's start, and --batch may come first; desk-env refuses it too.
for (const argv of [['logins', 'set', 'claude', 'spare', 'off'], ['--batch', 'x', 'logins', 'set', 'claude', 'spare', 'off'], ['--batch', 'x', 'logins', 'remove', 'claude', 'spare'],
  ['--batch', 'x', 'logins', 'default', 'claude', 'spare'], ['--batch=x', 'machine', 'set', 'k', 'v'], ['costs', '--batch', 'x', 'write']]) {
  const was = existsSync(env.DESK_SUBSCRIPTIONS) ? readFileSync(env.DESK_SUBSCRIPTIONS, 'utf8') : null;
  const r = spawnSync(process.execPath, [join(BIN, 'desk-env.mjs'), ...argv], { encoding: 'utf8', env: { ...process.env, DESK_AUTOPILOT_WORKER: '1' } });
  t(`a worker's desk-env ${argv.join(' ')} is refused`, r.status === 4 && /refused in an autopilot worker/.test(r.stderr) && (existsSync(env.DESK_SUBSCRIPTIONS) ? readFileSync(env.DESK_SUBSCRIPTIONS, 'utf8') : null) === was, true);
}
t('desk-env logins remove refuses the default login', deskEnv('remove', 'claude', 'personal').stderr.trim().startsWith('logins: claude personal is'), true);
// The set u runs after x puts a removed login back in its own folder, though its name is not its folder's.
subscriptions([['claude', 'spare', '~/.claude-logins/spare', 'default'], ['claude', 'office', '~/.claude-logins/work', 'unused'], ROWS[2]]);
deskEnv('remove', 'claude', 'office');
const back = deskEnv('set', 'claude', 'office', 'unused');
t('u after x on a login named apart from its folder puts back that folder', `${back.status} ${/^\| `claude` \| `office` \| `~\/.claude-logins\/work` \| `unused` \|$/m.test(subsText())} ${/^## Removed/m.test(subsText())}`, '0 true false');

// ---- AC4: the default at its 5-hour limit still reads default, its 5H bar at 100% with the reset time
subscriptions(ROWS);
repo({ default: { login: 'personal', config_dir: null, type: 'five_hour', resets_at: at(24, 14, 5), since: FIXED - 20 * MIN, by: 'S-1' } });
claudeReading(null, [1, at(24, 14, 5)], [0.66, at(27, 6, 0)]);
const B = await usage();
t('AC4 the default at its limit reads ◉ default, its 5H bar at 100% with the reset', rowOf(B.frame(), 'me@example.test'),
  row(1, 'me@example.test', 'Ultra', '◉ default', '██████████ 100% 14:05', '███████··· 66% Tue 06:00', '0'));
B.done();
repo();
claudeReading(null, [0.31, at(24, 14, 5)], [0.61, at(27, 6, 0)]);

// ---- DS-472 AC5: a Codex plan with no 5-hour window
codexReading(join(H, '.codex'), null, [27, at(26, 9, 0)], 'prolite');
const W = await usage();
t('DS-472 AC5 the 5H cell says the plan has no 5-hour window, never 0% or no reading yet', rowOf(W.frame(), 'codexmain'),
  row(0, 'codexmain', 'prolite', '◉ default', 'no 5h limit', '███······· 27% Mon 09:00', '—'));
W.done();

// ---- DS-472 AC12: a login with no reading yet, one the repo is pinned to
rmSync(join(env.DESK_USAGE_DIR, 'probe.work.log'));
repo({}, 'work@example.test');
const N = await usage();
f = N.frame();
t('DS-472 AC12 a login with no reading yet says so in its 5H and 7D cells', rowOf(f, 'work@example.test'),
  row(0, 'work@example.test', 'Max 5x', '● 2 repos', 'no reading yet', 'no reading yet', '0'));
t('DS-472 AC12 and a note says when it will be read', f.some((l) => /^note {2}no reading {5}Logins with no reading yet are read in the next 5 minutes\./.test(l)), true);
N.done();
// No repo pinned to it: the scheduled probe does not read it, and the note does not promise it will.
repo();
config('acme__web');
const N2 = await usage();
f = N2.frame();
t('a login no repo is pinned to, with no reading: the note says it is read once one is', f.some((l) => /^note {2}no reading {5}A login no repo is pinned to is read only once one is/.test(l)), true);
t('and does not promise a read in 5 minutes', f.some((l) => /read in the next 5 minutes/.test(l)), false);
N2.done();

// ---- every Codex login at its limit: the default still reads default
codexReading(join(H, '.codex'), [100, at(24, 16, 40)], [27, at(26, 9, 0)]);
codexReading(ALT, [100, at(24, 12, 0)], [9, at(30, 18, 0)], 'plus');
const X = await usage();
f = X.frame();
t('every Codex login at its limit: the Codex default still reads default, its bar full', rowOf(f, 'codexmain').slice(0, 71), row(0, 'codexmain', 'pro', '◉ default', '██████████ 100% 16:40', '', '').slice(0, 71));
t('and the other reads unused', useOf(f, 'alt'), '○ unused');
X.done();
codexReading(join(H, '.codex'), null, [27, at(26, 9, 0)], 'prolite');

// ---- AC16, AC17: one Claude login and no subscriptions file
rmSync(join(H, '.claude-logins'), { recursive: true, force: true });
rmSync(join(H, '.codex-logins'), { recursive: true, force: true });
rmSync(env.DESK_SUBSCRIPTIONS);
const One = await usage();
f = One.frame();
t('AC16 its only Claude row reads ◉ default', rowOf(f, 'me@example.test').slice(0, 50), row(1, 'me@example.test', 'Ultra', '◉ default', '', '', '').slice(0, 50));
t('the line under the tabs says every worker runs on the one login', f[3], 'Every worker runs on the one login desk knows here. A batch waits when that login is at its limit.');
await One.press('d');
await sleep(300);
t('AC17 d on its row writes no subscriptions file', existsSync(env.DESK_SUBSCRIPTIONS), false);
One.done();

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all desk-q Usage view checks passed');
process.exit(fails ? 1 : 0);
