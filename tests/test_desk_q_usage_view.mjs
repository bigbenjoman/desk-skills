// suite: desk-q Usage view (view 6: every Claude and Codex login with its plan, use and both windows)
// desk-q's view 6 against a subscriptions file, each Claude login's .claude.json and probe log, each Codex
// login's session logs, each repo's Subscription row and a queue's usage hold, on a fixed clock, under
// a throwaway HOME, DESK_HOME, DESK_CONFIG_ROOT, DESK_LOCK_DIR and DESK_USAGE_DIR, with fake claude and
// codex binaries the account check calls. The default, undo and remove keys run desk-env's logins
// commands. Drawn at 104 columns under NO_COLOR. One check or more per acceptance criterion of DS-472,
// DS-623 and DS-624, and for DS-625's drawn states.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('desk-q-usage-view-');
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
// Each Claude account has a folder of its own, pinned to it (DS-528): ~/.claude is the person's own.
const PERSONAL = join(H, '.claude-logins', 'personal'), WORK = join(H, '.claude-logins', 'work'), SPARE = join(H, '.claude-logins', 'spare'), ALT = join(H, '.codex-logins', 'alt');
for (const d of [env.DESK_LOCK_DIR, env.DESK_USAGE_DIR, join(H, '.claude'), PERSONAL, WORK, SPARE, join(H, '.codex'), ALT]) mkdirSync(d, { recursive: true });
// desk-q runs on the default's folder, as the pass does: a worker or a hold that names no login is on it.
process.env.CLAUDE_CONFIG_DIR = PERSONAL;
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
// Each Claude login's account as its .claude.json records it; the default's is ~/.claude.json.
const account = (path, email, plan) => writeFileSync(path, JSON.stringify({ oauthAccount: { emailAddress: email, planDisplayName: plan } }));
account(join(PERSONAL, '.claude.json'), 'me@example.test', 'Ultra');
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
// the default (a worker with no login file runs on desk-q's own login, the default's folder).
// A running worker's login file, naming the default's folder.
function onDefault(slug, key) {
  const dir = join(H, '.desk-autopilot', slug, 'workers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.login.json`), JSON.stringify({ name: 'personal', config_dir: PERSONAL }));
}
function repo(hold = null, sub = null, running = 0) {
  const slug = 'acme__solo';
  config(slug, sub);
  const q = join(env.DESK_HOME, 'repos', slug, 'queue.json');
  mkdirSync(dirname(q), { recursive: true });
  const tickets = { 'S-1': { key: 'S-1', state: 'triaged' } };
  for (let i = 0; i < running; i++) { tickets[`S-${i + 2}`] = { key: `S-${i + 2}`, state: 'running' }; onDefault(slug, `S-${i + 2}`); }
  writeFileSync(q, JSON.stringify({ version: 1, batch: 'solo', concurrency: 2, tickets, ...(hold ? { usage_hold: hold } : {}) }));
}
// Rows as [tool, name, folder, rule]: each Claude row is written pinned to the account its folder is for.
const PINS = { personal: 'me@example.test', work: 'work@example.test', spare: 'spare@example.test' };
const pinOf = (r) => (r[0] === 'claude' ? PINS[r[2].split('/').at(-1)] ?? '-' : '-');
const subscriptions = (rows) => writeFileSync(env.DESK_SUBSCRIPTIONS,
  `| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n${rows.map((r) => `| ${[...r.slice(0, 3), pinOf(r), r[3]].map((c) => `\`${c}\``).join(' | ')} |`).join('\n')}\n`);
const ROWS = [['claude', 'personal', '~/.claude-logins/personal', 'default'], ['claude', 'work', '~/.claude-logins/work', 'unused'],
  ['codex', 'codexmain', '~/.codex', 'default'], ['codex', 'alt', '~/.codex-logins/alt', 'unused']];

// A Claude login's probe log holding one reading, written `ago` before FIXED.
function claudeReading(key, five, seven, ago = MIN) {
  const path = join(env.DESK_USAGE_DIR, key ? `probe.${key}.log` : 'probe.log');
  writeFileSync(path, `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: five[0], resetsAt: five[1] }, seven_day: { utilization: seven[0], resetsAt: seven[1] } } } })}\n`);
  utimesSync(path, (FIXED - ago) / 1000, (FIXED - ago) / 1000);
}
claudeReading('personal', [0.31, at(24, 14, 5)], [0.61, at(27, 6, 0)]);
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

// desk-q open at `columns` (104) under NO_COLOR (in colour with `color`), its account check and keys
// running desk-env for real. `raw` is the frame with its colours.
function open(start = { kind: 'overview', all: false }, columns = 104, color = false) {
  if (color) delete process.env.NO_COLOR; else process.env.NO_COLOR = '1';
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = { buf: '', columns, rows: 60, write(s) { this.buf += s; }, on() {}, removeListener() {} };
  const copied = [];
  const ui = Q.interactive({ input, output, start, exit() {}, refreshMs: 600000, clock: () => FIXED, probeMs: 600000, probeWith: async () => ({ ran: true }), copier: (s) => copied.push(s) });
  const raw = () => output.buf.split('\x1b[H').at(-1).split('\r\n');
  const frame = () => raw().map((l) => plain(l.replace(/\x1b\[J$/, '').replace(/\x1b\[K$/, '')));
  const press = async (k) => { input.write(k); await sleep(20); };
  // Until `pred` holds of the frame, or 10 seconds.
  const until = async (pred) => { for (let i = 0; i < 500 && !pred(frame()); i++) await sleep(20); return frame(); };
  // The selection moved down (or by `key`) onto the row starting `name`.
  const pick = async (name, key = DOWN) => { for (let i = 0; i < 8 && !frame().find((l) => l.startsWith('›'))?.slice(2).startsWith(`${name} `); i++) await press(key); };
  return { ui, frame, raw, press, until, pick, copied, done() { ui.finish(0); delete process.env.NO_COLOR; } };
}
// Usage open on its first frame after the account check.
async function usage(start, columns, color) {
  const u = open(start, columns, color);
  await sleep(20);
  await u.press('6');
  await u.until((x) => x.some((l) => l.startsWith('  Read at') || l.startsWith('  No login')));
  await sleep(150);
  return u;
}
const rowOf = (f, name) => f.find((l) => l.slice(2).startsWith(`${name} `)) ?? null;
// A row as the canvas lays it out: a 2-column lead, then NAME 25, PLAN 9, USE 14, 5H 21, 7D 25 and
// WORKERS 7 on the right. `windows` given alone is one cell across 5H and 7D.
// (A Codex PLAN comes from its auth.json id_token alone, DS-532: none here, so —.)
const cellPad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
const row = (sel, name, plan, use, h5, d7, w) => `${sel ? '›' : ' '} ${cellPad(name, 25)}${cellPad(plan, 9)}${cellPad(use, 14)}${d7 == null ? cellPad(h5, 46) : cellPad(h5, 21) + cellPad(d7, 25)}${w.padStart(7)}`;
const useOf = (f, name) => rowOf(f, name)?.slice(36, 50).trimEnd() ?? null;
// The footer line, which can wrap onto the next.
const footer = (f, start) => { const i = f.findIndex((l) => l.startsWith(start)); return i < 0 ? null : f[i].length >= 100 ? `${f[i]} ${f[i + 1]}` : f[i]; };
const checked = (f) => !f.includes('Saving…');
const subsText = () => readFileSync(env.DESK_SUBSCRIPTIONS, 'utf8');
const ruleIn = (tool, name) => (new RegExp(`^\\| \`${tool}\` \\| \`${name}\` \\| [^|]+ \\| [^|]+ \\| \`([^\`]+)\` \\|$`, 'm').exec(subsText()) ?? [])[1];
const deskEnv = (...args) => spawnSync(process.execPath, [join(BIN, 'desk-env.mjs'), 'logins', ...args], { encoding: 'utf8', env: process.env });

// solo and api follow the default, web is pinned to work; two workers run on the default.
repo(null, null, 2);
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
// spare, found under ~/.claude-logins, is shown once desk-q has pinned it to its account (DS-533 AC19).
f = await S.until((x) => !!rowOf(x, 'spare@example.test'));
const HEAD = '  SUBSCRIPTION             PLAN     USE           5H                   7D                       WORKERS';
t('AC1 the Claude table\'s columns are SUBSCRIPTION, PLAN, USE, 5H, 7D and WORKERS', f.includes(HEAD), true);
t('AC1 the default reads ◉ default, with its plan, both windows and its 2 workers', rowOf(f, 'me@example.test'),
  row(1, 'me@example.test', 'Ultra', '◉ default', '███······· 31% 14:05', '██████···· 61% Tue 06:00', '2'));
t('AC1 a subscription one repo is pinned to reads ● 1 repo', rowOf(f, 'work@example.test'),
  row(0, 'work@example.test', 'Max 5x', '● 1 repo', '██████···· 58% 13:20', '███████··· 72% Mon 09:00', '0'));
t('AC1 a subscription no repo runs on reads ○ unused', rowOf(f, 'spare@example.test'),
  row(0, 'spare@example.test', 'Pro', '○ unused', '·········· 0% 15:00', '██········ 18% Thu 22:00', '0'));
t('the Codex table keeps its layout, with USE in place of RULE', f.includes('  CODEX                    PLAN     USE           5H                   7D                       WORKERS'), true);
t('AC12 the Codex default reads ◉ default', rowOf(f, 'codexmain'), row(0, 'codexmain', '—', '◉ default', '██········ 16% 16:40', '███······· 27% Mon 09:00', '—'));
t('AC12 the other Codex login reads ○ unused', rowOf(f, 'alt'), row(0, 'alt', '—', '○ unused', '·········· 0% 12:00', '█········· 9% Fri 18:00', '—'));
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

// ---- DS-624 AC1-AC6: the repo table, on four more repos
// A repo's queue with `running` workers and `ready` tickets ready to start.
function batch(slug, running, ready) {
  const q = join(env.DESK_HOME, 'repos', slug, 'queue.json');
  mkdirSync(dirname(q), { recursive: true });
  const tickets = {};
  for (let i = 0; i < running; i++) { tickets[`R-${i}`] = { key: `R-${i}`, state: 'running' }; onDefault(slug, `R-${i}`); }
  for (let i = 0; i < ready; i++) tickets[`T-${i}`] = { key: `T-${i}`, state: 'triaged' };
  writeFileSync(q, JSON.stringify({ version: 1, concurrency: 20, tickets }));
}
const FOUR = ['acme__voicepa', 'acme__pr-ninja', 'acme__idle', 'acme__elsewhere'];
config('acme__voicepa', 'work@example.test');
batch('acme__voicepa', 1, 2);
config('acme__pr-ninja');
batch('acme__pr-ninja', 2, 8);
config('acme__idle');
config('acme__elsewhere', 'stranger@example.test');
// A repo row as the canvas lays it out: REPO 16, RUNS ON 28, SET 13, then WORKERS 9 and READY 8 on the right.
const repoLine = (sel, name, runs, set, w, r) => `${sel ? '›' : ' '} ${cellPad(name, 16)}${cellPad(runs, 28)}${cellPad(set, 13)}${w.padStart(9)}${r.padStart(8)}`;
S = await usage();
f = S.frame();
const REPO_HEAD = `  ${cellPad('REPO', 16)}${cellPad('RUNS ON', 28)}${cellPad('SET', 13)}${'WORKERS'.padStart(9)}${'READY'.padStart(8)}`;
t('DS-624 AC1 a second table has the columns REPO, RUNS ON, SET, WORKERS and READY', f.includes(REPO_HEAD), true);
t('DS-624 AC1 it comes after the subscription table', f.indexOf(REPO_HEAD) > f.findIndex((l) => l.slice(2).startsWith('spare@example.test ')), true);
t('DS-624 AC1 a pinned repo reads its subscription ▾, ● pinned, 1 worker and 2 ready', rowOf(f, 'voicepa'), repoLine(0, 'voicepa', 'work@example.test ▾', '● pinned', '1', '2'));
t('DS-624 AC1 a repo on the default reads the default ▾, ○ default, 2 workers and 8 ready', rowOf(f, 'pr-ninja'), repoLine(0, 'pr-ninja', 'me@example.test ▾', '○ default', '2', '8'));
t('DS-624 AC2 a repo with no batch reads 0 workers and 0 ready', rowOf(f, 'idle'), repoLine(0, 'idle', 'me@example.test ▾', '○ default', '0', '0'));
t('DS-624 AC6 a row naming an email that is no subscription here shows it, pinned', rowOf(f, 'elsewhere'), repoLine(0, 'elsewhere', 'stranger@example.test ▾', '● pinned', '0', '0'));
// AC4, AC5: ↓ from the last subscription row selects the first repo row, and ↑ comes back.
await S.pick('spare@example.test');
await S.press(DOWN);
f = S.frame();
t('DS-624 AC4 ↓ on the last subscription row selects the first repo row', f[f.indexOf(REPO_HEAD) + 1].startsWith('› '), true);
await S.press('\x1b[A');
t('DS-624 AC5 ↑ on the first repo row selects the last subscription row', rowOf(S.frame(), 'spare@example.test').startsWith('› '), true);

// ---- DS-625 AC13, AC15, AC1, AC2, AC3: a repo row's keys, the hint under the table, and its dropdown
const HINT = '  Select a repo and press enter, or click its subscription, to change which one it runs on.';
const CODEX_HEAD = '  CODEX                    PLAN     USE           5H                   7D                       WORKERS';
f = S.frame();
t('DS-625 AC15 a grey line under the repo table says how to change a repo\'s subscription', f[f.indexOf(CODEX_HEAD) - 2], HINT);
await S.pick('pr-ninja');
t('DS-625 AC13 a repo row selected with nothing to undo: the keys offer enter, a, : and q', S.frame().at(-1),
  '↑↓ select · ←→ or 1–6 view · enter change subscription · a add · : command · q quit');
await S.press('\r');
f = S.frame();
// The dropdown as the canvas lays it out: 18 columns in, a 60-wide box, then number 2, name 26 and 28 more.
const IN = ' '.repeat(18);
const edge = (l, r) => `${IN}${l}${'─'.repeat(58)}${r}`;
const opt = (n, name, rest) => `${IN}│ ${cellPad(n, 2)}${cellPad(name, 26)}${cellPad(rest, 28)} │`;
const sub = (plan, h5, d7) => `${cellPad(plan, 9)}5h ${h5} · 7d ${d7}`;
const ri = f.indexOf(rowOf(f, 'pr-ninja'));
t('DS-625 AC1 enter opens the dropdown under the row, its arrow ▴', f.slice(ri, ri + 8).join('\n'), [
  repoLine(1, 'pr-ninja', 'me@example.test ▴', '○ default', '2', '8'),
  edge('┌', '┐'),
  opt('1', 'Default ✓', '→ me@example.test'),
  opt('2', 'me@example.test', sub('Ultra', '31%', '61%')),
  opt('3', 'work@example.test', sub('Max 5x', '58%', '72%')),
  opt('4', 'spare@example.test', sub('Pro', '0%', '18%')),
  edge('└', '┘'),
  `${IN} ✓ now · 1-4 or ↑↓ enter choose · esc close`].join('\n'));
t('DS-625 AC2 the keys while it is open', f.at(-1), '↑↓ choose · ←→ view · 1-4 pick · enter save · esc close · q quit');
t('DS-625 AC15 the hint gives way to the open dropdown', f.includes(HINT), false);
// A lone esc reaches the keys once readline's escape timeout has passed.
await S.press('\x1b');
await sleep(700);
t('DS-625 esc closes the dropdown', S.frame().includes(edge('┌', '┐')), false);
await S.pick('voicepa');
await S.press('\r');
f = S.frame();
t('DS-625 AC3 a pinned repo\'s dropdown: ✓ on its subscription, not on Default', `${f.includes(opt('1', 'Default', '→ me@example.test'))} | ${f.includes(opt('3', 'work@example.test ✓', sub('Max 5x', '58%', '72%')))}`, 'true | true');
S.done();
// AC2 where the keys go on two lines, the act line reads as the canvas has it.
S = await usage(undefined, 60);
await S.pick('pr-ninja');
await S.press('\r');
f = S.frame();
t('DS-625 AC2 the act line, where the keys wrap', f.at(-1), 'act   1-4 pick · enter save · esc close · q quit');
t('DS-625 AC2 and the move line above it', f.at(-2), 'move  ↑↓ choose · ←→ view');
S.done();
// AC3: with work the default, every repo on the default runs on work.
deskEnv('default', 'claude', 'work');
S = await usage();
f = S.frame();
t('DS-624 AC3 the default changed: each ○ default row runs on the new default', `${rowOf(f, 'pr-ninja')} | ${rowOf(f, 'idle')}`,
  `${repoLine(0, 'pr-ninja', 'work@example.test ▾', '○ default', '2', '8')} | ${repoLine(0, 'idle', 'work@example.test ▾', '○ default', '0', '0')}`);
S.done();
subscriptions(ROWS);
for (const slug of FOUR) { config(slug, false); rmSync(join(env.DESK_HOME, 'repos', slug), { recursive: true, force: true }); }

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
// spare pinned to its account (DS-528), as desk-q pins a found folder.
subscriptions([...ROWS.slice(0, 2), ['claude', 'spare', '~/.claude-logins/spare', 'unused'], ...ROWS.slice(2)]);

// ---- DS-472 AC10, AC11, AC15: a signed-out login says so, the headline too, and y copies its sign-in command
writeFileSync(join(SPARE, '.signed-out'), '');
const O = open({ kind: 'overview', all: false });
await sleep(20);
await O.press('6');
f = await O.until((x) => x.some((l) => l.includes('not signed in')));
// A pinned account (DS-533): not signed in, PLAN — as its folder's may be another account's.
t('DS-472 AC10 DS-533 AC6 a signed-out account says it is not signed in and desk will not use it', rowOf(f, 'spare@example.test'),
  row(0, 'spare@example.test', '—', '○ unused', '◆ not signed in: desk won\'t use it', null, '0'));
t('AC15 the headline says it isn\'t signed in, naming no login workers start on', f[3], "spare@example.test isn't signed in yet, so desk can't use it.");
t('DS-472 AC10 DS-533 AC7 a note says how to sign it in', f.join(' ').replace(/\s+/g, ' ').includes('◆ sign in spare@example.test isn\'t signed in for desk yet. In another terminal, run CLAUDE_CONFIG_DIR=~/.claude-logins/spare claude, then type /login and sign in to spare@example.test. Press y to copy the command.'), true);
await O.pick('spare@example.test');
t('DS-472 AC11 with it selected, the keys offer y', O.frame().at(-1).includes('y copy command'), true);
await O.press('d');
await sleep(200);
t('d on a signed-out login is refused, the file unchanged', `${ruleIn('claude', 'personal')} ${O.frame().includes("spare@example.test isn't signed in yet, so it can't be the default. Sign it in first.")}`, 'default true');
await O.press('y');
t('DS-472 AC11 y copies its sign-in command to the clipboard', O.copied.join('\n'), 'CLAUDE_CONFIG_DIR=~/.claude-logins/spare claude');
t('DS-472 AC11 and the footer says so', footer(O.frame(), 'Copied'), 'Copied the sign-in command: CLAUDE_CONFIG_DIR=~/.claude-logins/spare claude. Run it in another terminal, then /login.');
await O.pick('codexmain');
await O.press('y');
t('y on a signed-in login copies nothing and says why', `${O.copied.length} ${O.frame().some((l) => l.startsWith('codexmain is signed in, so there is no sign-in command to copy.'))}`, '1 true');
rmSync(join(SPARE, '.signed-out'));

// ---- DS-472 AC9, AC17: x removes an unused login, leaving its folder and sign-in
await O.pick('spare@example.test', '\x1b[A');
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
t('u after x on a login named apart from its folder puts back that folder', `${back.status} ${/^\| `claude` \| `office` \| `~\/.claude-logins\/work` \| `[^`]+` \| `unused` \|$/m.test(subsText())} ${/^## Removed/m.test(subsText())}`, '0 true false');

// ---- AC4: the default at its 5-hour limit still reads default, its 5H bar at 100% with the reset time
subscriptions(ROWS);
repo({ since: new Date(FIXED - 20 * MIN).toISOString(), type: 'five_hour', resets_at: at(24, 14, 5), preflight: 'S-1', paused: [], login_dir: PERSONAL });
claudeReading('personal', [1, at(24, 14, 5)], [0.66, at(27, 6, 0)]);
const B = await usage();
t('AC4 the default at its limit reads ◉ default, its 5H bar at 100% with the reset', rowOf(B.frame(), 'me@example.test'),
  row(1, 'me@example.test', 'Ultra', '◉ default', '██████████ 100% 14:05', '███████··· 66% Tue 06:00', '0'));
// DS-792: a listing scoped to another repo, which loads solo only lightly, still reads solo's hold on the default.
config('acme__other792');
batch('acme__other792', 0, 1);
const limit792 = (word) => JSON.stringify(Q.usageOf(Q.loadRepos(FIXED, word), FIXED).logins?.claude?.limit ?? null);
t('DS-792 AC2 a listing scoped to another repo reads solo\'s usage hold as the unscoped listing does',
  `${limit792(null) !== 'null'} ${limit792('other792') === limit792(null)}`, 'true true');
config('acme__other792', false);
rmSync(join(env.DESK_HOME, 'repos', 'acme__other792'), { recursive: true, force: true });
B.done();
repo();
claudeReading('personal', [0.31, at(24, 14, 5)], [0.61, at(27, 6, 0)]);

// ---- At a subscription's limit, which repos wait, how many tickets are ready and when they start
// A login's probe log holding the rejection a real worker recorded at its limit (usage-limit-five-hour.json),
// its limit `type` and both windows as given.
const LIMIT_EVENT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'usage-limit-five-hour.json'), 'utf8');
function limitReading(key, type, five, seven) {
  const ev = JSON.parse(LIMIT_EVENT);
  const info = ev.rate_limit_info;
  info.rateLimitType = type;
  info.resetsAt = (type === 'five_hour' ? five : seven)[1];
  info.unifiedWindows = { five_hour: { utilization: five[0], resetsAt: five[1] }, seven_day: { utilization: seven[0], resetsAt: seven[1] } };
  const path = join(env.DESK_USAGE_DIR, key ? `probe.${key}.log` : 'probe.log');
  writeFileSync(path, `${JSON.stringify(ev)}\n`);
  utimesSync(path, (FIXED - MIN) / 1000, (FIXED - MIN) / 1000);
}
const WAIT_LAST = '  Repos pinned elsewhere keep running. Nothing moves to another subscription on its own.';
const KEYS_SUB = '↑↓ select · ←→ or 1–6 view · d make default · a add · x remove · : command · q quit';
const KEYS_REPO = '↑↓ select · ←→ or 1–6 view · enter change subscription · a add · : command · q quit';
// pr-ninja (8 ready) and forewatt (3 ready) follow the default; solo, api and web are pinned to work.
repo(null, 'work@example.test');
config('acme__api', 'work@example.test');
config('acme__pr-ninja');
batch('acme__pr-ninja', 0, 8);
config('acme__forewatt');
batch('acme__forewatt', 0, 3);
limitReading('personal', 'five_hour', [1, at(24, 14, 5)], [0.66, at(27, 6, 0)]);
let L = await usage();
f = L.frame();
t('DS-626 AC1 the default at its 5-hour limit: the headline says so and when its workers start', f[3],
  'me@example.test, the default, is at its 5-hour limit until 14:05. Its workers start again then.');
const wait1 = f.findIndex((l) => l.startsWith('■ '));
t('DS-626 AC3 a ■ note names the repos waiting for it, their ready tickets and when they start', f[wait1],
  '■ pr-ninja and forewatt wait for me@example.test: 11 tickets ready, starting at 14:05.');
t('DS-626 AC3 and the line under it says pinned repos keep running and nothing moves', f[wait1 + 1], WAIT_LAST);
t('DS-626 the notes sit under the repo table, a blank line between, in place of the hint',
  `${f[wait1 - 1] === ''} ${f[wait1 - 2] === rowOf(f, 'web')} ${f.includes(HINT)}`, 'true true false');
t('DS-626 AC6 a subscription row selected: the act line is the one with no limit', f.at(-1), KEYS_SUB);
await L.pick('pr-ninja');
t('DS-626 AC6 a repo row selected: the act line is the one with no limit', L.frame().at(-1), KEYS_REPO);
L.done();
// AC4 in colour: the waiting repos' RUNS ON in red, and no other repo's.
const RED = '\x1b[38;5;210m';
L = await usage(undefined, 104, true);
const runsRed = (name) => { const l = L.raw().find((x) => plain(x).slice(2).startsWith(`${name} `)) ?? ''; return l.includes(`${RED}me@example.test`) || l.includes(`${RED}work@example.test`); };
t('DS-626 AC4 pr-ninja\'s and forewatt\'s RUNS ON are red, and solo\'s, api\'s and web\'s are not',
  ['pr-ninja', 'forewatt', 'solo', 'api', 'web'].map(runsRed).join(' '), 'true true false false false');
t('DS-626 AC4 the ■ is red', L.raw().some((x) => x.includes(`${RED}■`)), true);
L.done();
// AC2: at its weekly limit.
limitReading('personal', 'seven_day', [0.4, at(24, 14, 5)], [1, at(27, 6, 0)]);
L = await usage();
f = L.frame();
t('DS-626 AC2 the default at its weekly limit: the headline says so', f[3],
  'me@example.test, the default, is at its weekly limit until Tue 06:00. Its workers start again then.');
t('DS-626 AC2 and the ■ note starts them then', f.find((l) => l.startsWith('■ ')), '■ pr-ninja and forewatt wait for me@example.test: 11 tickets ready, starting at Tue 06:00.');
L.done();
// AC5: desk-skills (1 ready) pinned to work, at its 5-hour limit, while the default has room.
claudeReading('personal', [0.31, at(24, 14, 5)], [0.61, at(27, 6, 0)]);
limitReading('work', 'five_hour', [1, at(24, 15, 40)], [0.72, at(26, 9, 0)]);
repo();
config('acme__api');
config('acme__web');
config('acme__desk-skills', 'work@example.test');
batch('acme__desk-skills', 0, 1);
L = await usage();
f = L.frame();
t('DS-626 AC5 a pinned subscription at its limit: the headline is the usual one', f[3], "Workers run on me@example.test, this computer's default, unless their repo is pinned.");
t('DS-626 AC5 its ■ note names the one repo and its one ticket', f.filter((l) => l.startsWith('■ ')).join('\n'), '■ desk-skills waits for work@example.test: 1 ticket ready, starting at 15:40.');
t('DS-626 AC5 and the line under it', f[f.findIndex((l) => l.startsWith('■ ')) + 1], WAIT_LAST);
L.done();
// AC8: the default and work both at their 5-hour limits.
limitReading('personal', 'five_hour', [1, at(24, 14, 5)], [0.66, at(27, 6, 0)]);
L = await usage();
f = L.frame();
t('DS-626 AC8 two at their limits: the headline is the default\'s', f[3], 'me@example.test, the default, is at its 5-hour limit until 14:05. Its workers start again then.');
t('DS-626 AC8 a ■ note each, the default\'s first, then the one line', f.slice(f.findIndex((l) => l.startsWith('■ ')), f.indexOf(WAIT_LAST) + 1).join('\n'), [
  '■ pr-ninja, forewatt, solo, api and web wait for me@example.test: 12 tickets ready, starting at 14:05.',
  '■ desk-skills waits for work@example.test: 1 ticket ready, starting at 15:40.', WAIT_LAST].join('\n'));
L.done();
// AC7: no subscription at its limit.
claudeReading('personal', [0.31, at(24, 14, 5)], [0.61, at(27, 6, 0)]);
claudeReading('work', [0.58, at(24, 13, 20)], [0.72, at(26, 9, 0)]);
L = await usage();
f = L.frame();
t('DS-626 AC7 no subscription at its limit: no ■ note and no "Nothing moves" line', `${f.some((l) => l.startsWith('■'))} ${f.some((l) => l.includes('Nothing moves to another subscription on its own.'))}`, 'false false');
t('DS-626 AC7 and the hint is back under the repo table', f.includes(HINT), true);
L.done();
for (const slug of ['acme__pr-ninja', 'acme__forewatt', 'acme__desk-skills']) { config(slug, false); rmSync(join(env.DESK_HOME, 'repos', slug), { recursive: true, force: true }); }
config('acme__web', 'work@example.test');

// ---- DS-472 AC5: a Codex plan with no 5-hour window
codexReading(join(H, '.codex'), null, [27, at(26, 9, 0)], 'prolite');
const W = await usage();
t('DS-472 AC5 the 5H cell says the plan has no 5-hour window, never 0% or no reading yet', rowOf(W.frame(), 'codexmain'),
  row(0, 'codexmain', '—', '◉ default', 'no 5h limit', '███······· 27% Mon 09:00', '—'));
W.done();

// ---- DS-472 AC12: a login with no reading yet, one the repo is pinned to
rmSync(join(env.DESK_USAGE_DIR, 'probe.work.log'));
repo(null, 'work@example.test');
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
t('every Codex login at its limit: the Codex default still reads default, its bar full', rowOf(f, 'codexmain').slice(0, 71), row(0, 'codexmain', '—', '◉ default', '██████████ 100% 16:40', '', '').slice(0, 71));
t('and the other reads unused', useOf(f, 'alt'), '○ unused');
X.done();
codexReading(join(H, '.codex'), null, [27, at(26, 9, 0)], 'prolite');

// ---- AC16, AC17: one Claude login and no subscriptions file
rmSync(join(H, '.claude-logins'), { recursive: true, force: true });
rmSync(join(H, '.codex-logins'), { recursive: true, force: true });
rmSync(env.DESK_SUBSCRIPTIONS);
// With no file, desk-q runs on ~/.claude, the one login.
delete process.env.CLAUDE_CONFIG_DIR;
account(join(H, '.claude.json'), 'me@example.test', 'Ultra');
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
