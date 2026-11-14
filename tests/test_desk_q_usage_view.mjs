// suite: desk-q Usage view (view 6: every Claude and Codex login with its plan, rule and both windows)
// desk-q's view 6 against a subscriptions file, each Claude login's .claude.json and probe log, each Codex
// login's session logs and a queue's benched logins, on a fixed clock, under a throwaway HOME, DESK_HOME,
// DESK_CONFIG_ROOT, DESK_LOCK_DIR and DESK_USAGE_DIR, with fake claude and codex binaries the account
// check calls. The rule, undo and remove keys run desk-env's logins commands. Drawn at 104 columns under
// NO_COLOR. One check or more per acceptance criterion of DS-472, and of DS-533 (accounts pinned to
// folders: one row per account, the wrong-account, not signed in and not set up rows, and desk-q's own
// migrate and pin).
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
const PERSONAL = ['claude', 'personal', '~/.claude', 'in rotation'], CODEXMAIN = ['codex', 'codexmain', '~/.codex', 'in rotation'];
const ROWS = [['claude', 'home', '~/.claude-logins/home', 'me@example.test', 'in rotation'], ['claude', 'work', '~/.claude-logins/work', 'work@example.test', 'in rotation'],
  CODEXMAIN, ['codex', 'alt', '~/.codex-logins/alt', 'standby']];
const SPARE_ROW = ['claude', 'spare', '~/.claude-logins/spare', 'spare@example.test', 'standby'];

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
const claudeRows = (f) => { const i = f.findIndex((l) => l.startsWith('  CLAUDE ')); return i < 0 ? [] : f.slice(i + 1, f.indexOf('', i)); };
const prose = (f) => f.join(' ').replace(/\s+/g, ' ');
// A row as the canvas lays it out: a 2-column lead, then NAME 25, PLAN 9, RULE 14, 5H 21, 7D 25 and
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
subscriptions([PERSONAL, ['claude', 'work', '~/.claude-logins/work', 'in rotation'], CODEXMAIN]);
const M = open();
await sleep(20);
await M.press('6');
let f = await M.until((x) => /\| Account \|/.test(subsText()) && x.some((l) => l.includes('Press a to add it.')));
t('DS-533 AC17 desk-q migrates the old file: work is pinned to its account and keeps its rule', /^\| `claude` \| `work` \| `~\/.claude-logins\/work` \| `work@example.test` \| `in rotation` \|$/m.test(subsText()), true);
t('DS-533 AC17 AC19 and the found spare is pinned on standby', /^\| `claude` \| `spare` \| `~\/.claude-logins\/spare` \| `spare@example.test` \| `standby` \|$/m.test(subsText()), true);
t('DS-533 AC17 ~/.claude goes to the Removed table', /^## Removed[\s\S]*^\| `claude` \| `personal` \| `~\/.claude` \|$/m.test(subsText()), true);
t('DS-533 AC17 once: the file has one Account column', subsText().split('| Account |').length, 2);
t('DS-533 AC18 the footer offers to add ~/.claude\'s account', f.find((l) => l.includes('Press a to add it.'))?.trim(), 'me@example.test isn\'t one of desk\'s accounts yet. Press a to add it.');
t('DS-533 AC2 no row for ~/.claude', `${rowOf(f, 'me@example.test')} ${rowOf(f, 'personal')} ${rowOf(f, 'default')}`, 'null null null');
M.done();

// From here, three accounts each pinned to a folder; spare is found, not listed, until desk-q pins it.
const HOMEL = join(H, '.claude-logins', 'home');
mkdirSync(HOMEL, { recursive: true });
account(join(HOMEL, '.claude.json'), 'me@example.test', 'Ultra');
subscriptions(ROWS);

// ---- AC1: 6 opens Usage
const S = open();
await sleep(20);
await S.press('6');
f = S.frame();
t('AC1 6 opens the Usage view, its tab highlighted', `${f[0].replace(/ · \d\d:\d\d$/, '')} | ${f[1]}`, 'desk-q | 1 Queue  2 Timeline  3 By day  4 Epics  5 Costs  6 Usage');
t('AC1 the tab line reads 1 Queue … 6 Usage', f[1], '1 Queue  2 Timeline  3 By day  4 Epics  5 Costs  6 Usage');

// ---- AC2, AC3, AC4, AC12: a CLAUDE and a CODEX table, each login with its plan, rule, both windows and workers
// desk-q pins the found spare on standby (DS-533 AC19), and the next check shows it.
await S.until(() => subsText().includes('`spare@example.test` | `standby`'));
f = await S.until((x) => !!rowOf(x, 'spare@example.test') && x.some((l) => l.includes('signs in for desk through')));
const HEAD = '  CLAUDE                   PLAN     RULE          5H                   7D                       WORKERS';
t('AC2 a CLAUDE table headed PLAN, RULE, 5H, 7D and WORKERS', f.includes(HEAD), true);
t('AC2 and a CODEX table with the same columns', f.includes(HEAD.replace('CLAUDE', 'CODEX ')), true);
t('AC2 AC3 a login: its pinned email, Ultra from its .claude.json, in rotation, both windows, 0 workers', rowOf(f, 'me@example.test'),
  row(1, 'me@example.test', 'Ultra', '● in rotation', '███······· 31% 14:05', '██████···· 61% Tue 06:00', '0'));
t('AC2 the work login in rotation', rowOf(f, 'work@example.test'),
  row(0, 'work@example.test', 'Max 5x', '● in rotation', '██████···· 58% 13:20', '███████··· 72% Mon 09:00', '0'));
t('AC2 DS-533 AC19 a folder under ~/.claude-logins the file did not list, pinned on standby', rowOf(f, 'spare@example.test'),
  row(0, 'spare@example.test', 'Pro', '○ standby', '·········· 0% 15:00', '██········ 18% Thu 22:00', '0'));
t('DS-533 AC1 the CLAUDE table has exactly the three accounts, none labelled default', claudeRows(f).map((l) => l.slice(2, 27).trim()).join(', '),
  'me@example.test, work@example.test, spare@example.test');
t('DS-533 AC12 the footer says desk\'s sign-ins are its own', f.some((l) => l.trim() === 'Desk keeps its own sign-ins, so switching account in your own Claude Code changes nothing here.'), true);
t('DS-533 AC13 and names the selected account\'s folder', f.some((l) => l.trim() === 'me@example.test signs in for desk through ~/.claude-logins/home.'), true);
t('DS-533 AC18 ~/.claude\'s account is pinned, so nothing offers to add it', f.some((l) => l.includes('Press a to add it.')), false);
t('AC4 a Codex login with no auth.json: its name, PLAN — whatever its reading logs (DS-532 AC3, AC6), and no worker count', rowOf(f, 'codexmain'),
  row(0, 'codexmain', '—', '● in rotation', '██········ 16% 16:40', '███······· 27% Mon 09:00', '—'));
t('AC4 the other Codex login on standby', rowOf(f, 'alt'),
  row(0, 'alt', '—', '○ standby', '·········· 0% 12:00', '█········· 9% Fri 18:00', '—'));
t('AC6 the line under the tabs names the logins new Claude and Codex work starts on', f[3],
  'New Claude workers start on me@example.test, Codex workers on codexmain: the most room.');
t('AC16 standby logins read before those in rotation: the footer says when', f.find((l) => l.startsWith('  Read at')),
  '  Read at 08:59 from worker logs. Standby logins were last read at 08:30.');
t('the rules\' key is under the tables', f.some((l) => l.startsWith('  ● in rotation new workers start on the one with most room · ○ standby')), true);
t('DS-533 AC20 AC11 the keys name space, x, a add an account and the views, and no y on a signed-in row', f.at(-1), '↑↓ select · ←→ or 1–6 view · space change rule · x remove · a add an account · : command · q quit');

// ---- AC7, AC8: space moves the rule on and saves it at once; u puts it back
await S.press(' ');
f = await S.until(checked);
const HOME_RULE = (rule) => new RegExp(`\\| \`claude\` \\| \`home\` \\| \`~/.claude-logins/home\` \\| \`me@example.test\` \\| \`${rule}\` \\|`).test(subsText());
t('AC7 space: in rotation moves to standby, saved for this computer at once, keeping its account', HOME_RULE('standby'), true);
t('AC7 the footer says what changed and offers u to undo', footer(f, 'me@example.test is on standby'),
  'me@example.test is on standby: desk uses it only when every login in rotation is at its limit. Saved for this computer. · u undo');
t('AC7 the row shows the new rule', rowOf(f, 'me@example.test').slice(0, 50), row(1, 'me@example.test', 'Ultra', '○ standby', '', '', '').slice(0, 50));
await S.press(' ');
await S.until(checked);
t('AC7 space again: standby moves to off', HOME_RULE('off'), true);
f = S.frame();
t('AC14 a login whose rule is off: its 5H cell says not used', rowOf(f, 'me@example.test'),
  row(1, 'me@example.test', 'Ultra', '◌ off', 'not used', '██████···· 61% Tue 06:00', '0'));
await S.press('u');
f = await S.until(checked);
t('AC8 u restores the previous rule and saves it', HOME_RULE('standby'), true);
t('AC8 and the footer says so, with no further undo', footer(f, 'me@example.test is on standby'),
  'me@example.test is on standby: desk uses it only when every login in rotation is at its limit. Saved for this computer.');
await S.press('u');
t('u with nothing to undo says so', S.frame().includes('Nothing to undo.'), true);
await S.press(' '); await S.until(checked);
await S.press(' '); await S.until(checked);
t('space from off comes round to in rotation', HOME_RULE('in rotation'), true);
S.done();

// ---- DS-533: one folder switched to another account and one signed out, with ~/.claude on an account
// none is pinned to: each row says why desk won't use it, and its note how to fix it
const ROWS3 = [ROWS[0], ROWS[1], SPARE_ROW, ROWS[2], ROWS[3]];
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
t('DS-533 AC3 the wrong-account row keeps its pinned email, PLAN —, one cell naming the account it is on, and no readings', rowOf(f, 'spare@example.test'),
  row(0, 'spare@example.test', '—', '○ standby', '◆ on work@example.test: desk won\'t use it', null, '0'));
t('DS-533 AC4 its note says what happened and how to switch it back', prose(f).includes('◆ wrong account Desk\'s sign-in for spare@example.test is now on work@example.test, so desk counts that account once and has stopped using this one. To switch it back, run CLAUDE_CONFIG_DIR=~/.claude-logins/spare claude in another terminal, then type /login and sign in to spare@example.test. Press y to copy the command.'), true);
t('DS-533 AC6 the signed-out row: PLAN —, one cell saying it is not signed in, 0 workers', rowOf(f, 'work@example.test'),
  row(0, 'work@example.test', '—', '● in rotation', '◆ not signed in: desk won\'t use it', null, '0'));
t('DS-533 AC7 its note gives the sign-in command', prose(f).includes('◆ sign in work@example.test isn\'t signed in for desk yet. In another terminal, run CLAUDE_CONFIG_DIR=~/.claude-logins/work claude, then type /login and sign in to work@example.test. Press y to copy the command.'), true);
t('DS-533 AC5 AC9 with both, the line under the tabs is the wrong-account one', headline(f),
  'New Claude workers start on me@example.test. spare@example.test\'s sign-in was switched to another account, so desk has stopped using it.');
t('DS-533 AC18 ~/.claude\'s account, pinned to no row, is offered to add', f.some((l) => l.trim() === 'own@example.test isn\'t one of desk\'s accounts yet. Press a to add it.'), true);
t('DS-533 AC22 none of the old one-account copy', /◆ same account as above|2 logins are signed in to|◆ one account/.test(f.join('\n')), false);
t('DS-533 AC11 a signed-in row selected: no y in the keys', f.at(-1).includes('y copy command'), false);
await D.press(DOWN); await D.press(DOWN);
f = D.frame();
t('DS-533 AC10 the wrong-account row selected: the keys offer y copy command', f.at(-1).includes('y copy command'), true);
t('DS-533 AC13 and the footer names its folder', f.some((l) => l.trim() === 'spare@example.test signs in for desk through ~/.claude-logins/spare.'), true);
await D.press('y');
t('DS-533 AC10 y copies the command that signs its folder in', D.copied.join('\n'), 'CLAUDE_CONFIG_DIR=~/.claude-logins/spare claude');
D.done();
account(join(SPARE, '.claude.json'), 'spare@example.test', 'Pro');
rmSync(join(WORK, '.signed-out'));
account(join(H, '.claude.json'), 'me@example.test', 'Ultra');

// ---- DS-533 AC14, AC16: a folder desk could not pin is not set up, named by its folder
const L5 = join(H, '.claude-logins', 'login-5');
mkdirSync(L5, { recursive: true });
writeFileSync(join(L5, '.signed-out'), '');
const U = open();
await sleep(20);
await U.press('6');
f = await U.until((x) => (rowOf(x, 'login-5') ?? '').includes('◆ not set up'));
t('DS-533 AC14 its row is labelled by its folder, one cell saying it is not set up', rowOf(f, 'login-5'), row(0, 'login-5', '—', '○ standby', '◆ not set up: desk won\'t use it', null, '0'));
t('DS-533 AC14 its note says how to add it or remove it', prose(f).includes('◆ not set up login-5 isn\'t one of desk\'s accounts. To add it, run CLAUDE_CONFIG_DIR=~/.claude-logins/login-5 claude in another terminal, type /login, and sign in to an account desk doesn\'t have. Press y to copy the command, or x to remove it.'), true);
for (let i = 0; i < 3; i++) await U.press(DOWN);
t('DS-533 AC16 it is selected', U.frame().find((l) => l.startsWith('›'))?.slice(2, 9), 'login-5');
await U.press('y');
t('DS-533 AC16 y copies its sign-in command', U.copied.join('\n'), 'CLAUDE_CONFIG_DIR=~/.claude-logins/login-5 claude');
U.done();
// AC15: hand-pinned to the account work already has.
subscriptions([...ROWS3.slice(0, 3), ['claude', 'login-5', '~/.claude-logins/login-5', 'work@example.test', 'standby'], ...ROWS3.slice(3)]);
const U2 = open();
await sleep(20);
await U2.press('6');
f = await U2.until((x) => x.some((l) => l.includes('◆ not set up')) && !!rowOf(x, 'login-5'));
t('DS-533 AC15 a second folder pinned to one account: its note says whose', prose(f).includes('◆ not set up login-5 is pinned to the same account as work. To add it, run'), true);
t('DS-533 AC15 and its row is still named by its folder, work keeping the account', `${!!rowOf(f, 'login-5')} ${names(f).split(', ').filter((n) => n === 'work@example.test').length}`, 'true 1');
U2.done();
rmSync(L5, { recursive: true, force: true });
subscriptions(ROWS3);

// ---- the line under the tabs wraps, whole, however long the account names are
const LONG = 'a.very.long.account.name.indeed@example.test';
account(join(WORK, '.claude.json'), LONG, 'Max 5x');
subscriptions([ROWS[0], ['claude', 'work', '~/.claude-logins/work', LONG, 'in rotation'], ...ROWS3.slice(2)]);
repo({ home: { login: 'home', config_dir: HOMEL, type: 'seven_day', resets_at: at(27, 6, 0), since: 'x', by: 'x' } });
const LW = open({ kind: 'overview', all: false });
await sleep(20);
await LW.press('6');
f = LW.frame().map((l) => l.replace(/\u00a0/g, ' '));
t('a long headline is not cut', `${f[3]} ${f[4]}`, `New Claude workers start on ${LONG}: me@example.test is at its weekly limit until Tue 06:00.`);
t('and a reset time stays on one line', f[4].endsWith('Tue 06:00.') && !f[3].endsWith('Tue'), true);
LW.done();
account(join(WORK, '.claude.json'), 'work@example.test', 'Max 5x');
subscriptions(ROWS3);
repo();

// ---- AC10, AC11: a signed-out login says so, and y copies its sign-in command
writeFileSync(join(SPARE, '.signed-out'), '');
const O = open({ kind: 'overview', all: false });
await sleep(20);
await O.press('6');
f = await O.until((x) => x.some((l) => l.includes('not signed in')));
t('AC10 DS-533 AC6 a signed-out account says it is not signed in and desk will not use it, its PLAN —', rowOf(f, 'spare@example.test'),
  row(0, 'spare@example.test', '—', '○ standby', '◆ not signed in: desk won\'t use it', null, '0'));
t('AC10 DS-533 AC7 a note says how to sign it in', prose(f).includes('◆ sign in spare@example.test isn\'t signed in for desk yet. In another terminal, run CLAUDE_CONFIG_DIR=~/.claude-logins/spare claude, then type /login and sign in to spare@example.test. Press y to copy the command.'), true);
t('DS-533 AC8 the line under the tabs says it is not signed in', headline(f),
  'New Claude workers start on me@example.test. spare@example.test isn\'t signed in yet, so desk can\'t use it.');
await O.press(DOWN); await O.press(DOWN);
t('AC11 with it selected, the keys offer y', O.frame().at(-1).includes('y copy command'), true);
await O.press('y');
t('AC11 y copies its sign-in command to the clipboard', O.copied.join('\n'), 'CLAUDE_CONFIG_DIR=~/.claude-logins/spare claude');
t('AC11 and the footer says so', footer(O.frame(), 'Copied'), 'Copied the sign-in command: CLAUDE_CONFIG_DIR=~/.claude-logins/spare claude. Run it in another terminal, then /login.');
await O.press(DOWN);
await O.press('y');
t('y on a signed-in login copies nothing and says why', `${O.copied.length} ${O.frame().some((l) => l.startsWith('codexmain is signed in, so there is no sign-in command to copy.'))}`, '1 true');
rmSync(join(SPARE, '.signed-out'));

// ---- AC9, AC17: x removes a login from the rules, leaving its folder and sign-in
await O.press('\x1b[A');
t('x acts on the selected login', O.frame().find((l) => l.startsWith('›'))?.slice(2, 20), 'spare@example.test');
await O.press('x');
f = await O.until(checked);
t('AC9 x removes the login from the rules for this computer, and the footer says its folder and sign-in stay', footer(f, 'spare@example.test is removed'),
  'spare@example.test is removed from the rules for this computer. Its folder and sign-in are left as they are. · u undo');
t('AC9 its folder and sign-in are left as they are', `${existsSync(SPARE)} ${existsSync(join(SPARE, '.claude.json'))}`, 'true true');
t('AC9 the file names it as removed', /^\| `claude` \| `spare` \| `~\/.claude-logins\/spare` \|$/m.test(subsText()), true);
t('AC9 the view no longer lists it', rowOf(f, 'spare@example.test'), null);
const check17 = JSON.parse(deskEnv('check', '--json').stdout);
t('AC17 the next account check does not list it on standby again', check17.logins.some((l) => l.name === 'spare'), false);
await O.press('u');
await O.until(checked);
t('u after x lists it again, on its rule', /`spare` \| `~\/.claude-logins\/spare` \| (`[^`]*` \| )?`standby` \|/.test(subsText()) && !/^\| `claude` \| `spare` \| `~\/.claude-logins\/spare` \|$/m.test(subsText()), true);
O.done();
subscriptions([PERSONAL, CODEXMAIN]);
// A worker's deny rules match on the command's start, and --batch may come first; desk-env refuses it too.
for (const argv of [['logins', 'set', 'claude', 'spare', 'off'], ['--batch', 'x', 'logins', 'set', 'claude', 'spare', 'off'], ['--batch', 'x', 'logins', 'remove', 'claude', 'spare'], ['--batch=x', 'machine', 'set', 'k', 'v'], ['costs', '--batch', 'x', 'write']]) {
  const before = existsSync(env.DESK_SUBSCRIPTIONS) ? readFileSync(env.DESK_SUBSCRIPTIONS, 'utf8') : null;
  const r = spawnSync(process.execPath, [join(BIN, 'desk-env.mjs'), ...argv], { encoding: 'utf8', env: { ...process.env, DESK_AUTOPILOT_WORKER: '1' } });
  t(`a worker's desk-env ${argv.join(' ')} is refused`, r.status === 4 && /refused in an autopilot worker/.test(r.stderr) && (existsSync(env.DESK_SUBSCRIPTIONS) ? readFileSync(env.DESK_SUBSCRIPTIONS, 'utf8') : null) === before, true);
}
t('desk-env logins remove refuses the default login', deskEnv('remove', 'claude', 'personal').stderr.trim().startsWith('logins: claude personal is ~/.claude'), true);
// The set u runs puts a removed login back in its own folder, though its name is not its folder's; and
// space on a default login the file does not list (no rule) gives it the rule.
subscriptions([['claude', 'office', '~/.claude-logins/work', 'in rotation'], ['claude', 'spare', '~/.claude-logins/spare', 'standby'], ROWS[2]]);
deskEnv('remove', 'claude', 'office');
const back = deskEnv('set', 'claude', 'office', 'in rotation');
t('AC8 u after x on a login named apart from its folder puts back that folder', `${back.status} ${/^\| `claude` \| `office` \| `~\/.claude-logins\/work` \| `in rotation` \|$/m.test(subsText())} ${/^## Removed/m.test(subsText())}`, '0 true false');
const def = deskEnv('set', 'claude', 'default', 'standby');
t('AC7 space on a default login the file does not list gives it the next rule', `${def.status} ${/^\| `claude` \| `default` \| `~\/.claude` \| `standby` \|$/m.test(subsText())}`, '0 true');
subscriptions([['claude', 'default', '~/.claude-logins/spare', 'standby'], ['claude', 'office', '~/.claude-logins/work', 'in rotation'], ROWS[2]]);
deskEnv('remove', 'claude', 'default');
deskEnv('set', 'claude', 'default', 'standby');
t('AC8 u after x on a login named default in another folder puts back that folder, not ~/.claude',
  `${/^\| `claude` \| `default` \| `~\/.claude-logins\/spare` \| `standby` \|$/m.test(subsText())} ${/`~\/.claude` \|/.test(subsText())}`, 'true false');

// A file saying default and unused: space that makes a login the default demotes the old one, and u
// puts both back.
subscriptions([['claude', 'personal', '~/.claude', 'default'], ['claude', 'work', '~/.claude-logins/work', 'off'], ROWS[2]]);
const ruleIn = (name) => (new RegExp(`^\\| \`claude\` \\| \`${name}\` \\| [^|]+ \\| \`([^\`]+)\` \\|$`, 'm').exec(subsText()) ?? [])[1];
const Dft = open();
await sleep(20);
await Dft.press('6');
await Dft.until((x) => rowOf(x, 'work@example.test'));
for (let i = 0; i < 6 && !Dft.frame().find((l) => l.startsWith('›'))?.includes('work@example.test'); i++) await Dft.press(DOWN);
await Dft.press(' ');
await Dft.until(checked);
t('space on an off login in a file saying default: it becomes the default, the old one unused', `${ruleIn('work')} ${ruleIn('personal')}`, 'default unused');
await Dft.press('u');
f = await Dft.until((x) => checked(x) && x.some((l) => l.includes('Saved for this computer.')));
t('u puts back both: the login off, the old default the default again', `${ruleIn('work')} ${ruleIn('personal')}`, 'off default');
t('and the footer names the login undone, with no further undo', footer(f, 'work@example.test'), "work@example.test is off: desk won't start workers on it. Saved for this computer.");
Dft.done();

// ---- AC13: a login benched at its limit
subscriptions(ROWS3);
repo({ home: { login: 'home', config_dir: HOMEL, type: 'five_hour', resets_at: at(24, 14, 5), since: FIXED - 20 * MIN, by: 'S-1' } });
claudeReading('home', [1, at(24, 14, 5)], [0.66, at(27, 6, 0)]);
const B = open();
await sleep(20);
await B.press('6');
f = B.frame();
t('AC13 its RULE cell shows it at its limit', rowOf(f, 'me@example.test'),
  row(1, 'me@example.test', 'Ultra', '■ at limit', '██████████ 100% 14:05', '███████··· 66% Tue 06:00', '0'));
t('AC13 the line under the tabs names the reset time', f[3], 'New Claude workers start on work@example.test: me@example.test is at its 5-hour limit until 14:05.');
B.done();
repo();
claudeReading('home', [0.31, at(24, 14, 5)], [0.61, at(27, 6, 0)]);

// ---- AC5: a Codex plan with no 5-hour window
codexReading(join(H, '.codex'), null, [27, at(26, 9, 0)], 'prolite');
const W = open();
await sleep(20);
await W.press('6');
t('AC5 the 5H cell says the plan has no 5-hour window, never 0% or no reading yet', rowOf(W.frame(), 'codexmain'),
  row(0, 'codexmain', '—', '● in rotation', 'no 5h limit', '███······· 27% Mon 09:00', '—'));
W.done();

// ---- AC12: a login with no reading yet
rmSync(join(env.DESK_USAGE_DIR, 'probe.work.log'));
const N = open();
await sleep(20);
await N.press('6');
f = N.frame();
t('AC12 a login with no reading yet says so in its 5H and 7D cells', rowOf(f, 'work@example.test'),
  row(0, 'work@example.test', 'Max 5x', '● in rotation', 'no reading yet', 'no reading yet', '0'));
t('AC12 and a note says when it will be read', f.some((l) => /^note {2}no reading {5}Logins with no reading yet are read in the next 5 minutes\./.test(l)), true);
N.done();

// ---- AC13: every Codex login at its limit
codexReading(join(H, '.codex'), [100, at(24, 16, 40)], [27, at(26, 9, 0)]);
codexReading(ALT, [100, at(24, 12, 0)], [9, at(30, 18, 0)], 'plus');
const X = open();
await sleep(20);
await X.press('6');
f = X.frame();
t('AC13 every Codex login at its limit: the line under the tabs names the first back and its reset time', f[3],
  'Every Codex login is at its limit, so no new Codex calls start. The first back is alt at 12:00.');
t('AC13 and its RULE cell shows it at its limit', rowOf(f, 'alt').slice(0, 50), row(0, 'alt', '—', '■ at limit', '', '', '').slice(0, 50));
X.done();
codexReading(join(H, '.codex'), null, [27, at(26, 9, 0)], 'prolite');

// ---- AC15: one Claude login and one Codex login
rmSync(join(H, '.claude-logins'), { recursive: true, force: true });
rmSync(join(H, '.codex-logins'), { recursive: true, force: true });
subscriptions([PERSONAL, CODEXMAIN]);
const One = open();
await sleep(20);
await One.press('6');
f = await One.until((x) => x.at(-1).includes('a add an account') && !x.includes('Saving…'));
await sleep(200);
f = One.frame();
t('DS-533 AC21 one login: no reassurance line, nothing offered to add, the file left as it was',
  `${f.some((l) => l.includes('Desk keeps its own sign-ins'))} ${f.some((l) => l.includes('Press a to add it.'))} ${/\| Account \|/.test(subsText())}`, 'false false false');
t('AC15 the Claude login shows only login as its rule', rowOf(f, 'me@example.test').slice(0, 50), row(1, 'me@example.test', 'Ultra', '● only login', '', '', '').slice(0, 50));
t('AC15 so does the Codex login', rowOf(f, 'codexmain').slice(0, 50), row(0, 'codexmain', '—', '● only login', '', '', '').slice(0, 50));
t('AC15 the line under the tabs says every worker runs on the one login', f[3], 'Every worker runs on the one login desk knows here. A batch waits when that login is at its limit.');
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
const LEAD = (name, plan) => row(0, name, plan, '● only login', '', '', '').slice(0, 50);
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
subscriptions([PERSONAL, ['codex', 'codexmain', '~/.codex', 'off'], ['codex', 'cw', '~/.codex-work', 'in rotation']]);
v = await codexRow('work@x.io');
t('DS-532 AC7 a Codex login whose folder is ~/.codex-work is labelled by its own id_token\'s email', v.row?.slice(0, 50), row(0, 'work@x.io', 'Plus', '● in rotation', '', '', '').slice(0, 50));

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all desk-q Usage view checks passed');
process.exit(fails ? 1 : 0);
