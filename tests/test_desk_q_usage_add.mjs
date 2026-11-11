// suite: desk-q Usage view adds a login (a, y, esc and the wait for its sign-in)
// desk-q's view 6 adding a Claude and a Codex login, under a throwaway HOME, DESK_HOME, DESK_CONFIG_ROOT,
// DESK_LOCK_DIR, DESK_USAGE_DIR and subscriptions file, with fake claude and codex binaries the account
// check (desk-env logins check) calls. A test signs a new folder in partway through the wait by writing
// what the fake binary reads. Drawn at 104 columns under NO_COLOR.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-q-usage-add-'));
const H = join(T, 'home');
mkdirSync(join(T, 'bin'));
writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
// A Claude folder is signed in once its .claude.json exists (~/.claude.json for the default); a Codex
// folder once it holds auth.json. Neither binary says more than whether it is signed in.
writeFileSync(join(T, 'bin', 'claude'), `#!/bin/sh
if [ -n "$CLAUDE_CONFIG_DIR" ]; then f="$CLAUDE_CONFIG_DIR/.claude.json"; else f="$HOME/.claude.json"; fi
if [ -f "$f" ]; then echo '{"loggedIn": true}'; exit 0; fi
echo '{"loggedIn": false}'; exit 1
`, { mode: 0o755 });
writeFileSync(join(T, 'bin', 'codex'), '#!/bin/sh\nd="${CODEX_HOME:-$HOME/.codex}"\n[ -f "$d/auth.json" ] || exit 1\necho "Logged in"\n', { mode: 0o755 });
const env = { HOME: H, DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_LOCK_DIR: join(T, 'locks'), DESK_USAGE_DIR: join(T, 'usage'), DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'), DESK_PLATFORM: 'darwin',
  DESK_SKILLS_DIR: join(T, 'skills'), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH', 'DESK_BATCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'COLORFGBG', 'COLORTERM', 'NO_COLOR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DESK_AUTOPILOT_WORKER']) delete process.env[k];
Object.assign(process.env, env);
for (const d of [env.DESK_LOCK_DIR, env.DESK_USAGE_DIR, join(H, '.claude'), join(H, '.codex')]) mkdirSync(d, { recursive: true });
writeFileSync(join(H, '.codex', 'auth.json'), '{}');
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
const account = (path, email, plan) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ oauthAccount: { emailAddress: email, planDisplayName: plan } })); };
account(join(H, '.claude.json'), 'me@example.test', 'Ultra');

const slug = 'acme__solo';
mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
  '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `3100` |\n| Autopilot worker concurrency | `2 / 3` | `2 / 3` |\n');
const q = join(env.DESK_HOME, 'repos', slug, 'queue.json');
mkdirSync(dirname(q), { recursive: true });
writeFileSync(q, JSON.stringify({ version: 1, batch: 'solo', concurrency: 2, tickets: { 'S-1': { key: 'S-1', state: 'triaged' } } }));
const subscriptions = (rows) => writeFileSync(env.DESK_SUBSCRIPTIONS,
  `| Tool | Name | Folder | Rule |\n|---|---|---|---|\n${rows.map((r) => `| ${r.map((c) => `\`${c}\``).join(' | ')} |`).join('\n')}\n`);
const subsText = () => (existsSync(env.DESK_SUBSCRIPTIONS) ? readFileSync(env.DESK_SUBSCRIPTIONS, 'utf8') : '');
subscriptions([['claude', 'personal', '~/.claude', 'in rotation'], ['codex', 'codexmain', '~/.codex', 'in rotation']]);

const Q = await import(join(BIN, 'desk-q.mjs'));
const { PassThrough } = await import('node:stream');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const DOWN = '\x1b[B', ESC = '\x1b';
const FIXED = new Date(2026, 9, 24, 9, 0).getTime();

// desk-q open at 104 columns under NO_COLOR, its account check running desk-env for real, rerun every
// 50ms while a login is being added.
function open(opts = {}) {
  process.env.NO_COLOR = '1';
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = { buf: '', columns: 104, rows: 60, write(s) { this.buf += s; }, on() {}, removeListener() {} };
  const copied = [];
  const ui = Q.interactive({ input, output, start: { kind: 'overview', all: false }, exit() {}, refreshMs: 600000, clock: () => FIXED, probeMs: 600000,
    probeWith: async () => ({ ran: true }), copier: (s) => copied.push(s), addCheckMs: 50, ...opts });
  const frame = () => output.buf.split('\x1b[H').at(-1).split('\r\n').map((l) => plain(l.replace(/\x1b\[J$/, '').replace(/\x1b\[K$/, '')));
  // Each key on its own read, as a terminal sends them.
  const press = async (...ks) => { for (const k of ks) { input.write(k); await sleep(60); } };
  const until = async (pred) => { for (let i = 0; i < 500 && !pred(frame()); i++) await sleep(20); return frame(); };
  return { frame, press, until, copied, done() { ui.finish(0); delete process.env.NO_COLOR; } };
}
const rowOf = (f, name) => f.find((l) => l.slice(2).startsWith(`${name} `)) ?? null;
const cellPad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
const row = (sel, name, plan, rule, h5, d7, w) => `${sel ? '›' : ' '} ${cellPad(name, 25)}${cellPad(plan, 9)}${cellPad(rule, 14)}${d7 == null ? cellPad(h5, 46) : cellPad(h5, 21) + cellPad(d7, 25)}${w.padStart(7)}`;
const has = (f, s) => f.some((l) => l.includes(s));
const NEW = join(H, '.claude-logins', 'login-2'), CODEX_NEW = join(H, '.codex-logins', 'login-2');

// ---- AC5: one Claude login and one Codex login: a line offers a
const A = open();
await sleep(20);
await A.press('6');
let f = await A.until((x) => has(x, 'Press a to add a login.'));
const offerAt = f.findIndex((l) => l.startsWith('  If you have'));
t('AC5 with one login of each, a line offers a to add a login', f.slice(offerAt, offerAt + 2).join(' ').replace(/\s+/g, ' ').trim(),
  'If you have another Claude or Codex subscription, add it and desk spreads workers across both, so a batch keeps running when one reaches its limit. Press a to add a login.');
t('AC5 and the keys offer a', f.at(-1).includes('a add an account'), true);

// ---- AC1: a adds a row on standby, waiting, and shows the sign-in command with y to copy it
await A.press('a');
f = A.frame();
t('AC1 a adds a row on standby waiting for its sign-in, selected', rowOf(f, 'login-2'), row(1, 'login-2', '—', '○ standby', 'waiting for you to sign it in …', null, '0'));
t('AC1 the view says it is adding a Claude login', has(f, '  Add a Claude login'), true);
t('AC1 and shows the sign-in command for a new folder under the logins folder', f.find((l) => l.trim().startsWith('CLAUDE_CONFIG_DIR='))?.trim(), 'CLAUDE_CONFIG_DIR=~/.claude-logins/login-2 claude');
t('AC1 then what to type in it', has(f, '     then type /login and sign in with the account you want to add.'), true);
t('AC1 the keys offer y to copy it and esc to stop waiting', f.at(-1), '↑↓ select · ←→ or 1–6 view · y copy the command · esc stop waiting · : command · q quit');
t('AC1 desk makes no folder for a Claude login: its sign-in does', existsSync(NEW), false);
await A.press('y');
t('AC1 y copies the command', A.copied.join('\n'), 'CLAUDE_CONFIG_DIR=~/.claude-logins/login-2 claude');
t('AC1 and the footer says so', has(A.frame(), 'The command is copied. esc stops waiting and removes login-2.'), true);

// ---- AC2: the folder signs in partway through the wait: its row shows its email and plan, on standby
mkdirSync(NEW, { recursive: true });
await sleep(150);
t('AC2 a folder made but not signed in yet still waits', rowOf(A.frame(), 'login-2'), row(1, 'login-2', '—', '○ standby', 'waiting for you to sign it in …', null, '0'));
account(join(NEW, '.claude.json'), 'new@example.test', 'Pro');
f = await A.until((x) => rowOf(x, 'new@example.test'));
t('AC2 once signed in the row shows its email and plan, still on standby', rowOf(f, 'new@example.test'), row(1, 'new@example.test', 'Pro', '○ standby', 'no reading yet', 'no reading yet', '0'));
t('AC2 and the footer says it is signed in', has(f, 'new@example.test is signed in and on standby. space puts it in rotation.'), true);
t('AC2 the wait is over: the keys are the view\'s own again', f.at(-1).includes('esc stop waiting'), false);

// ---- AC3: a folder signed in to an account already listed is refused, naming the login it duplicates
await A.press('a');
const DUP = join(H, '.claude-logins', 'login-3');
t('AC3 the next login gets the next folder', A.frame().find((l) => l.trim().startsWith('CLAUDE_CONFIG_DIR='))?.trim(), 'CLAUDE_CONFIG_DIR=~/.claude-logins/login-3 claude');
account(join(DUP, '.claude.json'), 'me@example.test', 'Ultra');
f = await A.until((x) => has(x, '◆ not set up: desk won\'t use it'));
t('AC3 the row is refused, naming the login it duplicates', f.filter((l) => l.slice(2).startsWith('me@example.test ') && l.includes('◆ not set up: desk won\'t use it')).length, 1);
t('AC3 and the footer names it too', has(f, 'login-3 is signed in to the same account as personal, so desk won\'t use it. x removes it.'), true);
t('AC3 nothing waits any longer', rowOf(f, 'login-3'), null);
A.done();
rmSync(DUP, { recursive: true, force: true });

// ---- AC4: esc stops waiting and removes the row
const E = open();
await sleep(20);
await E.press('6');
await E.until((x) => has(x, 'a add an account'));
// The file the last session's add left lists ~/.claude and finds login-2, so this session migrates it
// to account pins (DS-533 AC17) before a starts another add.
await E.until(() => /\| Account \|/.test(subsText()));
await sleep(300);
await E.press('a');
t('AC4 a third Claude login waits as login-3', rowOf(E.frame(), 'login-3'), row(1, 'login-3', '—', '○ standby', 'waiting for you to sign it in …', null, '0'));
await E.press(ESC);
f = await E.until((x) => !rowOf(x, 'login-3'));
t('AC4 esc removes the new row', rowOf(f, 'login-3'), null);
t('AC4 and says it stopped waiting', has(f, 'Stopped waiting: login-3 is not added.'), true);
t('AC4 the panel is gone', has(f, 'Add a Claude login'), false);
t('AC4 esc while waiting stays on Usage', f.some((l) => l.startsWith('  CLAUDE') && l.includes('PLAN')), true);

// ---- AC6: a on the CODEX table asks for the label first
f = E.frame();
const codexAt = f.findIndex((l) => l.slice(2).startsWith('codexmain '));
for (let i = 0; i < 4 && !E.frame().find((l) => l.startsWith('›'))?.includes('codexmain'); i++) await E.press(DOWN);
t('AC6 the Codex login is selected', codexAt > 0 && E.frame().find((l) => l.startsWith('›'))?.slice(2, 11), 'codexmain');
await E.press('a');
f = E.frame();
t('AC6 a on the CODEX table asks for the label before any command', `${f.at(-1).startsWith('Label for the new Codex login:')} ${has(f, 'CODEX_HOME=')}`, 'true false');
await E.press('\r');
t('AC6 an empty label is refused', has(E.frame(), 'Type a label first, or esc to cancel.'), true);
await E.press(...'work codex');
t('AC6 the label shows as it is typed', E.frame().at(-1).startsWith('Label for the new Codex login: work codex'), true);
await E.press('\r');
f = E.frame();
t('AC6 then the row waits on standby under its label', rowOf(f, 'work codex'), row(1, 'work codex', '—', '○ standby', 'waiting for you to sign it in …', null, '—'));
t('AC6 with the Codex sign-in command for its folder', f.find((l) => l.trim().startsWith('CODEX_HOME='))?.trim(), 'CODEX_HOME=~/.codex-logins/login-2 codex login');
t('AC6 the folder is made with its label in it', existsSync(join(CODEX_NEW, 'desk-label')) && readFileSync(join(CODEX_NEW, 'desk-label'), 'utf8'), 'work codex\n');

// ---- AC7: the Codex folder signs in: its row shows its label, signed in, on standby
writeFileSync(join(CODEX_NEW, 'auth.json'), '{}');
f = await E.until((x) => has(x, 'work codex is signed in'));
t('AC7 once signed in the row shows its label, still on standby', rowOf(f, 'work codex')?.slice(0, 50), row(1, 'work codex', '—', '○ standby', '', null, '').slice(0, 50));
t('AC7 and the footer says it is signed in', has(f, 'work codex is signed in and on standby. space puts it in rotation.'), true);
E.done();

// ---- esc on a Codex login takes away the folder desk made for it
const C = open();
await sleep(20);
await C.press('6');
await C.until((x) => has(x, 'a add an account'));
for (let i = 0; i < 6 && !C.frame().find((l) => l.startsWith('›'))?.includes('codexmain'); i++) await C.press(DOWN);
await C.press('a', ...'spare', '\r');
const CODEX_3 = join(H, '.codex-logins', 'login-3');
t('a second new Codex login gets login-3, its folder made', existsSync(join(CODEX_3, 'desk-label')), true);
await C.press(ESC);
f = await C.until((x) => has(x, 'Stopped waiting'));
t('esc removes the folder desk made, which held only its label', `${existsSync(CODEX_3)} ${has(f, 'Stopped waiting: spare is not added.')}`, 'false true');
C.done();

// ---- a save still running holds back the next write: desk-env rewrites the whole subscriptions file
const BEGUN = join(H, '.claude-logins', 'login-3');
let checkOut = '{"logins":[]}';
const writes = [];
const heldOpts = { loginsWith: (args, done) => { if (args[0] === 'check') done({ code: 0, out: checkOut, err: '' }); else writes.push({ args, done }); } };
const release = async () => { writes.at(-1).done({ code: 0, out: '', err: '' }); await sleep(20); };
const W = open(heldOpts);
await sleep(20);
await W.press('6');
await W.until((x) => has(x, 'a add an account'));
await W.press('a');
mkdirSync(BEGUN, { recursive: true });
writeFileSync(join(BEGUN, 'begun'), '');
await W.press('\x1b[A', ' ');
t('a rule change on another row is saving', writes.map((w) => w.args[0]).join(), 'set');
await W.press(ESC);
f = await W.until((x) => has(x, 'Still saving the last change.'));
t('esc during that save starts no second write', writes.length, 1);
t('and says why, the row still waiting', `${has(f, 'Still saving the last change.')} ${!!rowOf(f, 'login-3')}`, 'true true');
await release();
await W.press(ESC);
await W.until((x) => has(x, 'Saving…'));
t('esc once it is saved removes the login', writes.map((w) => w.args.slice(0, 3).join(' ')).at(-1), 'remove claude login-3');
await release();
W.done();
rmSync(BEGUN, { recursive: true, force: true });
writes.length = 0;
const V = open(heldOpts);
await sleep(20);
await V.press('6');
await V.until((x) => has(x, 'a add an account'));
await V.press('a', '\x1b[A', ' ');
t('a rule change is saving as the folder signs in', writes.length, 1);
checkOut = JSON.stringify({ logins: [{ tool: 'claude', configDir: BEGUN, state: 'signed in', rule: null, email: 'held@example.test' }] });
await sleep(150);
f = V.frame();
t('the sign-in starts no second write during that save', writes.length, 1);
t('and its one row keeps waiting', f.filter((l) => l.includes('waiting for you to sign it in')).length, 1);
await release();
await sleep(150);
t('once saved, the next check puts it on standby', writes.map((w) => w.args.join(' ')).at(-1), 'set claude login-3 standby');
V.done();

// ---- AC2 with no subscriptions file: the signed-in login is written down on standby
rmSync(env.DESK_SUBSCRIPTIONS);
rmSync(join(H, '.claude-logins'), { recursive: true, force: true });
const N = open();
await sleep(20);
await N.press('6');
await N.until((x) => has(x, 'a add an account'));
await N.press('a');
account(join(NEW, '.claude.json'), 'other@example.test', 'Max 5x');
f = await N.until((x) => has(x, 'other@example.test is signed in'));
t('AC2 with no subscriptions file the new login is saved on standby', /^\| `claude` \| `login-2` \| `~\/.claude-logins\/login-2` \| `standby` \|$/m.test(subsText()), true);
t('AC2 and its row shows it on standby', rowOf(f, 'other@example.test')?.slice(0, 50), row(1, 'other@example.test', 'Max 5x', '○ standby', '', null, '').slice(0, 50));
N.done();

// ---- AC3 with pins: a new folder signed in to a pinned account is refused, naming the pinned login
rmSync(join(H, '.claude-logins'), { recursive: true, force: true });
account(join(H, '.claude-logins', 'work', '.claude.json'), 'pin@example.test', 'Ultra');
writeFileSync(env.DESK_SUBSCRIPTIONS, '| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n| `claude` | `work` | `~/.claude-logins/work` | `pin@example.test` | `in rotation` |\n| `codex` | `codexmain` | `~/.codex` | `-` | `in rotation` |\n');
const P = open();
await sleep(20);
await P.press('6');
await P.until((x) => has(x, 'a add an account'));
await P.press('a');
const pinNew = /login-\d+/.exec(P.frame().find((l) => l.trim().startsWith('CLAUDE_CONFIG_DIR=')) ?? '')?.[0];
account(join(H, '.claude-logins', pinNew ?? 'missing', '.claude.json'), 'pin@example.test', 'Ultra');
f = await P.until((x) => has(x, 'so desk won\'t use it. x removes it.'));
t('AC3 with pins the footer names the pinned login', has(f, `${pinNew} is signed in to the same account as work, so desk won't use it. x removes it.`), true);
t('AC3 with pins the row reads not set up', f.some((l) => l.includes('◆ not set up: desk won\'t use it')), true);
t('AC3 with pins nothing waits any longer', has(f, 'waiting for you to sign it in'), false);
P.done();

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all desk-q Usage add-a-login checks passed');
process.exit(fails ? 1 : 0);
