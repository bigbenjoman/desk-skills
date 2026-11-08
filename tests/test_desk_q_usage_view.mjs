// suite: desk-q Usage view (view 6: every Claude and Codex login with its plan, rule and both windows)
// desk-q's view 6 against a subscriptions file, each Claude login's .claude.json and probe log, each Codex
// login's session logs and a queue's benched logins, on a fixed clock, under a throwaway HOME, DESK_HOME,
// DESK_CONFIG_ROOT, DESK_LOCK_DIR and DESK_USAGE_DIR, with fake claude and codex binaries the account
// check calls. The rule, undo and remove keys run desk-env's logins commands. Drawn at 104 columns under
// NO_COLOR. One check or more per acceptance criterion of DS-472.
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
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'COLORFGBG', 'COLORTERM', 'NO_COLOR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) delete process.env[k];
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
const subscriptions = (rows) => writeFileSync(env.DESK_SUBSCRIPTIONS,
  `| Tool | Name | Folder | Rule |\n|---|---|---|---|\n${rows.map((r) => `| ${r.map((c) => `\`${c}\``).join(' | ')} |`).join('\n')}\n`);
const ROWS = [['claude', 'personal', '~/.claude', 'in rotation'], ['claude', 'work', '~/.claude-logins/work', 'in rotation'],
  ['codex', 'codexmain', '~/.codex', 'in rotation'], ['codex', 'alt', '~/.codex-logins/alt', 'standby']];

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
const rowOf = (f, name) => f.find((l) => l.slice(2).startsWith(`${name} `)) ?? null;
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
subscriptions(ROWS);

// ---- AC1: 6 opens Usage
const S = open();
await sleep(20);
await S.press('6');
let f = S.frame();
t('AC1 6 opens the Usage view, its tab highlighted', `${f[0].replace(/ · \d\d:\d\d$/, '')} | ${f[1]}`, 'desk-q | 1 Queue  2 Timeline  3 By day  4 Epics  5 Costs  6 Usage');
t('AC1 the tab line reads 1 Queue … 6 Usage', f[1], '1 Queue  2 Timeline  3 By day  4 Epics  5 Costs  6 Usage');

// ---- AC2, AC3, AC4, AC12: a CLAUDE and a CODEX table, each login with its plan, rule, both windows and workers
f = await S.until((x) => x.some((l) => l.includes('signed out')) || false);
const HEAD = '  CLAUDE                   PLAN     RULE          5H                   7D                       WORKERS';
t('AC2 a CLAUDE table headed PLAN, RULE, 5H, 7D and WORKERS', f.includes(HEAD), true);
t('AC2 and a CODEX table with the same columns', f.includes(HEAD.replace('CLAUDE', 'CODEX ')), true);
t('AC2 AC3 the default login: its email, Ultra from its .claude.json, in rotation, both windows, 0 workers', rowOf(f, 'me@example.test'),
  row(1, 'me@example.test', 'Ultra', '● in rotation', '███······· 31% 14:05', '██████···· 61% Tue 06:00', '0'));
t('AC2 the work login in rotation', rowOf(f, 'work@example.test'),
  row(0, 'work@example.test', 'Max 5x', '● in rotation', '██████···· 58% 13:20', '███████··· 72% Mon 09:00', '0'));
t('AC2 a folder under ~/.claude-logins the file does not list, on standby', rowOf(f, 'spare@example.test'),
  row(0, 'spare@example.test', 'Pro', '○ standby', '·········· 0% 15:00', '██········ 18% Thu 22:00', '0'));
t('AC4 a Codex login\'s PLAN is the plan its newest reading names, and Codex has no worker count', rowOf(f, 'codexmain'),
  row(0, 'codexmain', 'pro', '● in rotation', '██········ 16% 16:40', '███······· 27% Mon 09:00', '—'));
t('AC4 the other Codex login on standby, its plan as logged', rowOf(f, 'alt'),
  row(0, 'alt', 'plus', '○ standby', '·········· 0% 12:00', '█········· 9% Fri 18:00', '—'));
t('AC6 the line under the tabs names the logins new Claude and Codex work starts on', f[3],
  'New Claude workers start on me@example.test, Codex workers on codexmain: the most room.');
t('AC16 standby logins read before those in rotation: the footer says when', f.find((l) => l.startsWith('  Read at')),
  '  Read at 08:59 from worker logs. Standby logins were last read at 08:30.');
t('the rules\' key is under the tables', f.some((l) => l.startsWith('  ● in rotation new workers start on the one with most room · ○ standby')), true);
t('the keys name space, x, a and the views', f.at(-1), '↑↓ select · ←→ or 1–6 view · space change rule · x remove · a add a login · : command · q quit');

// ---- AC7, AC8: space moves the rule on and saves it at once; u puts it back
await S.press(' ');
f = await S.until(checked);
t('AC7 space: in rotation moves to standby, saved for this computer at once', /\| `claude` \| `personal` \| `~\/.claude` \| `standby` \|/.test(subsText()), true);
t('AC7 the footer says what changed and offers u to undo', footer(f, 'me@example.test is on standby'),
  'me@example.test is on standby: desk uses it only when every login in rotation is at its limit. Saved for this computer. · u undo');
t('AC7 the row shows the new rule', rowOf(f, 'me@example.test').slice(0, 50), row(1, 'me@example.test', 'Ultra', '○ standby', '', '', '').slice(0, 50));
await S.press(' ');
await S.until(checked);
t('AC7 space again: standby moves to off', /`personal` \| `~\/.claude` \| `off` \|/.test(subsText()), true);
f = S.frame();
t('AC14 a login whose rule is off: its 5H cell says not used', rowOf(f, 'me@example.test'),
  row(1, 'me@example.test', 'Ultra', '◌ off', 'not used', '██████···· 61% Tue 06:00', '0'));
await S.press('u');
f = await S.until(checked);
t('AC8 u restores the previous rule and saves it', /`personal` \| `~\/.claude` \| `standby` \|/.test(subsText()), true);
t('AC8 and the footer says so, with no further undo', footer(f, 'me@example.test is on standby'),
  'me@example.test is on standby: desk uses it only when every login in rotation is at its limit. Saved for this computer.');
await S.press('u');
t('u with nothing to undo says so', S.frame().includes('Nothing to undo.'), true);
await S.press(' '); await S.until(checked);
await S.press(' '); await S.until(checked);
t('space from off comes round to in rotation', /`personal` \| `~\/.claude` \| `in rotation` \|/.test(subsText()), true);
S.done();

// ---- AC10, AC11: a signed-out login says so, and y copies its sign-in command
writeFileSync(join(SPARE, '.signed-out'), '');
const O = open({ kind: 'overview', all: false });
await sleep(20);
await O.press('6');
f = await O.until((x) => x.some((l) => l.includes('signed out')));
t('AC10 a signed-out login says it is signed out and desk will not use it', rowOf(f, 'spare@example.test'),
  row(0, 'spare@example.test', 'Pro', '○ standby', '◆ signed out: desk won\'t use it', null, '0'));
t('AC10 a note says how to sign it back in', f.find((l) => l.startsWith('note  ◆ sign in')),
  'note  ◆ sign in      spare@example.test is signed out. Sign it back in, in another terminal:');
await O.press(DOWN); await O.press(DOWN);
t('AC11 with it selected, the keys offer y', O.frame().at(-1).includes('y copy the sign-in command'), true);
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
t('u after x lists it again, on its rule', /`spare` \| `~\/.claude-logins\/spare` \| `standby` \|/.test(subsText()) && !/^\| `claude` \| `spare` \| `~\/.claude-logins\/spare` \|$/m.test(subsText()), true);
O.done();
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

// ---- AC13: a login benched at its limit
subscriptions(ROWS);
repo({ default: { login: 'personal', config_dir: null, type: 'five_hour', resets_at: at(24, 14, 5), since: FIXED - 20 * MIN, by: 'S-1' } });
claudeReading(null, [1, at(24, 14, 5)], [0.66, at(27, 6, 0)]);
const B = open();
await sleep(20);
await B.press('6');
f = B.frame();
t('AC13 its RULE cell shows it at its limit', rowOf(f, 'me@example.test'),
  row(1, 'me@example.test', 'Ultra', '■ at limit', '██████████ 100% 14:05', '███████··· 66% Tue 06:00', '0'));
t('AC13 the line under the tabs names the reset time', f[3], 'New Claude workers start on work@example.test: me@example.test is at its 5-hour limit until 14:05.');
B.done();
repo();
claudeReading(null, [0.31, at(24, 14, 5)], [0.61, at(27, 6, 0)]);

// ---- AC5: a Codex plan with no 5-hour window
codexReading(join(H, '.codex'), null, [27, at(26, 9, 0)], 'prolite');
const W = open();
await sleep(20);
await W.press('6');
t('AC5 the 5H cell says the plan has no 5-hour window, never 0% or no reading yet', rowOf(W.frame(), 'codexmain'),
  row(0, 'codexmain', 'prolite', '● in rotation', 'no 5h limit', '███······· 27% Mon 09:00', '—'));
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
t('AC13 and its RULE cell shows it at its limit', rowOf(f, 'alt').slice(0, 50), row(0, 'alt', 'plus', '■ at limit', '', '', '').slice(0, 50));
X.done();
codexReading(join(H, '.codex'), null, [27, at(26, 9, 0)], 'prolite');

// ---- AC15: one Claude login and one Codex login
rmSync(join(H, '.claude-logins'), { recursive: true, force: true });
rmSync(join(H, '.codex-logins'), { recursive: true, force: true });
subscriptions([ROWS[0], ROWS[2]]);
const One = open();
await sleep(20);
await One.press('6');
f = One.frame();
t('AC15 the Claude login shows only login as its rule', rowOf(f, 'me@example.test').slice(0, 50), row(1, 'me@example.test', 'Ultra', '● only login', '', '', '').slice(0, 50));
t('AC15 so does the Codex login', rowOf(f, 'codexmain').slice(0, 50), row(0, 'codexmain', 'prolite', '● only login', '', '', '').slice(0, 50));
t('AC15 the line under the tabs says every worker runs on the one login', f[3], 'Every worker runs on the one login desk knows here. A batch waits when that login is at its limit.');
One.done();

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all desk-q Usage view checks passed');
process.exit(fails ? 1 : 0);
