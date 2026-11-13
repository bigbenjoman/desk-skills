// suite: desk-q Usage view adds an account or login (a, y, esc and the wait for its sign-in)
// desk-q's view 6 adding a Claude account and a Codex login, under a throwaway HOME, DESK_HOME, DESK_CONFIG_ROOT,
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
// A file with only a Codex row: no Claude account is pinned, so the first add signs ~/.claude's account in too.
writeFileSync(env.DESK_SUBSCRIPTIONS, '| Tool | Name | Folder | Rule |\n|---|---|---|---|\n| `codex` | `codexmain` | `~/.codex` | `in rotation` |\n');

const Q = await import(join(BIN, 'desk-q.mjs'));
const { callLogin } = await import(join(BIN, 'call-login.mjs'));
const { readSubscriptions } = await import(join(BIN, 'logins.mjs'));
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
const squash = (ls) => ls.join(' ').replace(/\s+/g, ' ').trim();
// The panel's numbered step, its wrapped lines joined: from the line "  <n>  " to the next blank or numbered one.
const stepText = (f, n) => {
  const at = f.findIndex((l) => l.startsWith(`  ${n}  `));
  if (at < 0) return null;
  const end = f.findIndex((l, i) => i > at && (!l.trim() || /^ {2}\d {2}/.test(l)));
  return squash(f.slice(at, end < 0 ? undefined : end));
};
const paraAfter = (f, start) => { const at = f.findIndex((l) => l.startsWith(start)); const end = f.findIndex((l, i) => i > at && !l.trim()); return at < 0 ? null : squash(f.slice(at, end)); };
const folderOf = (f) => /CLAUDE_CONFIG_DIR=~\/\.claude-logins\/(login-\d+)/.exec(f.join('\n'))?.[1] ?? null;
const waitingRow = (f) => f.find((l) => l.includes('waiting for you to sign in…')) ?? null;
const KEYS = '↑↓ select · ←→ or 1–6 view · y copy the command · esc cancel adding · : command · q quit';
const L = (n) => join(H, '.claude-logins', n);
const pinRow = (name, email, rule) => new RegExp(`^\\| \`claude\` \\| \`${name}\` \\| \`~/\\.claude-logins/${name}\` \\| \`${email.replace('.', '\\.')}\` \\| \`${rule}\` \\|$`, 'm');

// ---- with one login of each, a line offers a
const A = open();
await sleep(20);
await A.press('6');
let f = await A.until((x) => has(x, 'Press a to add a login.'));
const offerAt = f.findIndex((l) => l.startsWith('  If you have'));
t('with one login of each, a line offers a to add a login', squash(f.slice(offerAt, offerAt + 2)),
  'If you have another Claude or Codex subscription, add it and desk spreads workers across both, so a batch keeps running when one reaches its limit. Press a to add a login.');
t('and the keys offer a', f.at(-1).includes('a add an account'), true);

// ---- AC6 (and AC5): a file with only Codex rows: the first add asks for ~/.claude's account first
await A.press('a');
f = A.frame();
t('AC6 the panel is titled', has(f, '  ADD A CLAUDE ACCOUNT'), true);
t('AC6 its first step signs ~/.claude\'s account in to a folder of its own', stepText(f, 1),
  '1 In another terminal, run CLAUDE_CONFIG_DIR=~/.claude-logins/login-1 claude, then type /login and sign in to me@example.test.');
t('AC6 its second step is the new account', stepText(f, 2), '2 Then desk asks for the account you want to add, in a folder of its own.');
t('AC6 the waiting row is that account, selected', waitingRow(f), row(1, 'me@example.test', '—', '○ standby', 'waiting for you to sign in…', null, '0'));
t('AC6 the keys', f.at(-1), KEYS);
t('AC6 desk makes no folder for a Claude login: its sign-in does', existsSync(L('login-1')), false);
await A.press('y');
t('AC6 y copies the first folder\'s command', A.copied.at(-1), 'CLAUDE_CONFIG_DIR=~/.claude-logins/login-1 claude');

// ---- AC7: until that folder is signed in, a pass's Claude call runs on the caller's own environment
const callerEnv = { ...process.env };
t('AC7 before the first folder signs in, a Claude call keeps the caller\'s environment', callLogin({ env: callerEnv }).env, callerEnv);

// ---- AC8: the first folder signs in: it is pinned, ~/.claude goes to Removed, and the panel moves on
account(join(L('login-1'), '.claude.json'), 'me@example.test', 'Ultra');
f = await A.until((x) => folderOf(x) === 'login-2');
t('AC8 the file has the Account column', /^\| Tool \| Name \| Folder \| Account \| Rule \|$/m.test(subsText()), true);
t('AC8 with the first folder pinned to the current account, keeping ~/.claude\'s rule', pinRow('login-1', 'me@example.test', 'in rotation').test(subsText()), true);
t('AC8 and ~/.claude in the Removed table', /## Removed[\s\S]*^\| `claude` \| `default` \| `~\/\.claude` \|$/m.test(subsText()), true);
t('AC8 the panel moves on to the new account', `${stepText(f, 1)} | ${stepText(f, 2)}`,
  '1 In another terminal, run CLAUDE_CONFIG_DIR=~/.claude-logins/login-2 claude | 2 Type /login and sign in to the account you want to add.');
t('AC8 its row reads new account', waitingRow(f), row(1, 'new account', '—', '○ standby', 'waiting for you to sign in…', null, '0'));
t('AC8 and the footer names the folder the account signs in through', has(f, 'me@example.test signs in for desk through ~/.claude-logins/login-1.'), true);

// ---- AC9: the second folder signs in to a new account: it is pinned on standby
account(join(L('login-2'), '.claude.json'), 'new@example.test', 'Pro');
f = await A.until((x) => has(x, 'new@example.test is added'));
t('AC9 the new account is pinned on standby', pinRow('login-2', 'new@example.test', 'standby').test(subsText()), true);
t('AC9 its row shows on standby', rowOf(f, 'new@example.test')?.slice(0, 50), row(1, 'new@example.test', 'Pro', '○ standby', '', null, '').slice(0, 50));
t('AC9 the wait is over', f.at(-1).includes('esc stop adding'), false);
A.done();

// ---- AC1: with accounts pinned, a adds a new account row and the panel
const B = open();
await sleep(20);
await B.press('6');
await B.until((x) => has(x, 'a add an account'));
await B.press('a');
f = B.frame();
t('AC1 a new account row waits for its sign-in, selected', waitingRow(f), row(1, 'new account', '—', '○ standby', 'waiting for you to sign in…', null, '0'));
t('AC1 the panel is titled', has(f, '  ADD A CLAUDE ACCOUNT'), true);
t('AC1 step 1 runs the next free folder', stepText(f, 1), '1 In another terminal, run CLAUDE_CONFIG_DIR=~/.claude-logins/login-3 claude');
t('AC1 step 2', stepText(f, 2), '2 Type /login and sign in to the account you want to add.');
t('AC1 and what desk does next', paraAfter(f, '  Desk adds'),
  "Desk adds the account on standby as soon as it sees you're signed in. An account that's already listed isn't added twice: desk asks you to sign in to a different one.");
t('AC1 the keys', f.at(-1), KEYS);

// ---- AC4: y copies the panel's command
await B.press('y');
t('AC4 y copies the sign-in command', B.copied.at(-1), 'CLAUDE_CONFIG_DIR=~/.claude-logins/login-3 claude');

// ---- AC2: the new folder signs in to an account desk doesn't have: it is pinned on standby
account(join(L('login-3'), '.claude.json'), 'third@example.test', 'Max 5x');
f = await B.until((x) => has(x, 'third@example.test is added'));
t('AC2 the file gains the folder pinned on standby', pinRow('login-3', 'third@example.test', 'standby').test(subsText()), true);
t('AC2 view 6 shows it as an account row', rowOf(f, 'third@example.test')?.slice(0, 50), row(1, 'third@example.test', 'Max 5x', '○ standby', '', null, '').slice(0, 50));

// ---- AC3: a folder signed in to an account desk already has is not added, and the panel keeps waiting
await B.press('a');
t('AC3 the next account gets the next folder', folderOf(B.frame()), 'login-4');
account(join(L('login-4'), '.claude.json'), 'new@example.test', 'Pro');
f = await B.until((x) => has(x, "That's new@example.test"));
t('AC3 the panel says so', paraAfter(f, "  That's"), "That's new@example.test, which desk already has. Sign this folder in to a different account, or press esc.");
t('AC3 it keeps waiting', waitingRow(f)?.slice(2, 13), 'new account');
t('AC3 no row is added', /login-4/.test(subsText()), false);

// ---- AC10: esc stops adding; what is pinned stays and the file reads back
await B.press(ESC);
f = await B.until((x) => has(x, 'Cancelled:'));
t('AC10 esc stops adding', `${has(f, 'ADD A CLAUDE ACCOUNT')} ${!!waitingRow(f)}`, 'false false');
t('AC10 the accounts pinned so far stay', ['login-1', 'login-2', 'login-3'].every((n) => new RegExp(`\`${n}\` \\| \`~/\\.claude-logins/${n}\` \\| \`[^-]`).test(subsText())), true);
t('AC10 and the file reads back with no errors', readSubscriptions(env.DESK_SUBSCRIPTIONS).errors.length, 0);
B.done();

// ---- a on the CODEX table asks for the label first
const E = open();
await sleep(20);
await E.press('6');
await E.until((x) => has(x, 'a add an account'));
for (let i = 0; i < 6 && !E.frame().find((l) => l.startsWith('›'))?.includes('codexmain'); i++) await E.press(DOWN);
t('the Codex login is selected', E.frame().find((l) => l.startsWith('›'))?.slice(2, 11), 'codexmain');
await E.press('a');
f = E.frame();
t('a on the CODEX table asks for the label before any command', `${f.at(-1).startsWith('Label for the new Codex login:')} ${has(f, 'CODEX_HOME=')}`, 'true false');
await E.press('\r');
t('an empty label is refused', has(E.frame(), 'Type a label first, or esc to cancel.'), true);
await E.press(...'work codex');
t('the label shows as it is typed', E.frame().at(-1).startsWith('Label for the new Codex login: work codex'), true);
await E.press('\r');
f = E.frame();
const CODEX_NEW = join(H, '.codex-logins', 'login-2');
t('then the row waits on standby under its label', rowOf(f, 'work codex'), row(1, 'work codex', '—', '○ standby', 'waiting for you to sign it in …', null, '—'));
t('with the Codex panel', has(f, '  Add a Codex login'), true);
t('and the Codex sign-in command for its folder', f.find((l) => l.trim().startsWith('CODEX_HOME='))?.trim(), 'CODEX_HOME=~/.codex-logins/login-2 codex login');
t('the folder is made with its label in it', existsSync(join(CODEX_NEW, 'desk-label')) && readFileSync(join(CODEX_NEW, 'desk-label'), 'utf8'), 'work codex\n');

// ---- the Codex folder signs in: its row shows its label, signed in, on standby
writeFileSync(join(CODEX_NEW, 'auth.json'), '{}');
f = await E.until((x) => has(x, 'work codex is added'));
t('once signed in the row shows its label, still on standby', rowOf(f, 'work codex')?.slice(0, 50), row(1, 'work codex', '—', '○ standby', '', null, '').slice(0, 50));
t('and the footer says it is signed in', has(f, 'work codex is added, on standby. Press space to start giving it workers.'), true);
E.done();

// ---- esc on a Codex login takes away the folder desk made for it
const C = open();
await sleep(20);
await C.press('6');
await C.until((x) => has(x, 'a add an account'));
for (let i = 0; i < 8 && !C.frame().find((l) => l.startsWith('›'))?.includes('codexmain'); i++) await C.press(DOWN);
await C.press('a', ...'spare', '\r');
const CODEX_3 = join(H, '.codex-logins', 'login-3');
t('a second new Codex login gets login-3, its folder made', existsSync(join(CODEX_3, 'desk-label')), true);
await C.press(ESC);
f = await C.until((x) => has(x, 'Cancelled:'));
t('esc removes the folder desk made, which held only its label', `${existsSync(CODEX_3)} ${has(f, 'Cancelled: spare is not added.')}`, 'false true');
C.done();

// ---- a save still running holds back the next write: desk-env rewrites the whole subscriptions file
let checkOut = '{"logins":[]}';
const writes = [];
const heldOpts = { loginsWith: (args, done) => { if (args[0] === 'check') done({ code: 0, out: checkOut, err: '' }); else writes.push({ args, done }); } };
const release = async () => { writes.at(-1).done({ code: 0, out: '', err: '' }); await sleep(20); };
const W = open(heldOpts);
await sleep(20);
await W.press('6');
await W.until((x) => has(x, 'a add an account'));
await W.press('a');
const held = folderOf(W.frame());
const BEGUN = L(held ?? 'missing');
mkdirSync(BEGUN, { recursive: true });
writeFileSync(join(BEGUN, 'begun'), '');
await W.press('\x1b[A', ' ');
t('a rule change on another row is saving', writes.map((w) => w.args[0]).join(), 'set');
await W.press(ESC);
f = await W.until((x) => has(x, 'Still saving the last change.'));
t('esc during that save starts no second write', writes.length, 1);
t('and says why, the row still waiting', `${has(f, 'Still saving the last change.')} ${!!waitingRow(f)}`, 'true true');
await release();
await W.press(ESC);
await W.until((x) => has(x, 'Saving…'));
t('esc once it is saved removes the login', writes.map((w) => w.args.slice(0, 3).join(' ')).at(-1), `remove claude ${held}`);
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
t('and its one row keeps waiting', f.filter((l) => l.includes('waiting for you to sign in…')).length, 1);
await release();
await sleep(150);
t('once saved, the next check puts it on standby', writes.map((w) => w.args.join(' ')).at(-1), `set claude ${held} standby`);
V.done();

// ---- AC5 and AC10 with no subscriptions file: esc before the first sign-in writes nothing; after it,
// the pinned folder stays
rmSync(env.DESK_SUBSCRIPTIONS);
rmSync(join(H, '.claude-logins'), { recursive: true, force: true });
const N = open();
await sleep(20);
await N.press('6');
await N.until((x) => has(x, 'a add an account'));
await N.press('a');
f = N.frame();
t('AC5 with no file the first step signs ~/.claude\'s account in', stepText(f, 1),
  '1 In another terminal, run CLAUDE_CONFIG_DIR=~/.claude-logins/login-1 claude, then type /login and sign in to me@example.test.');
await N.press(ESC);
f = await N.until((x) => has(x, 'Cancelled:'));
t('AC10 esc before the first sign-in writes no file', existsSync(env.DESK_SUBSCRIPTIONS), false);
// a on a Claude row: the selection fell where the waiting row was.
for (let i = 0; i < 6 && !N.frame().find((l) => l.startsWith('›'))?.includes('me@example.test'); i++) await N.press('\x1b[A');
await N.press('a');
t('AC10 a again starts the first add over', folderOf(N.frame()), 'login-1');
account(join(L('login-1'), '.claude.json'), 'me@example.test', 'Ultra');
f = await N.until((x) => folderOf(x) === 'login-2');
await N.press(ESC);
f = await N.until((x) => has(x, 'Cancelled: the new account is not added.'));
t('AC10 esc on the second step keeps the first folder pinned', pinRow('login-1', 'me@example.test', 'in rotation').test(subsText()), true);t('AC10 and the file reads back with no errors', readSubscriptions(env.DESK_SUBSCRIPTIONS).errors.length, 0);
N.done();

// ---- a file saying default and unused: view 6 shows them as in rotation and standby. The default is
// the folder under the logins folder, and ~/.claude the unused one: read any other way, ~/.claude
// would be in rotation and login-2 found on standby.
rmSync(join(H, '.claude-logins'), { recursive: true, force: true });
account(join(L('login-2'), '.claude.json'), 'other@example.test', 'Max 5x');
subscriptions([['claude', 'personal', '~/.claude', 'unused'], ['claude', 'login-2', '~/.claude-logins/login-2', 'default'], ['codex', 'codexmain', '~/.codex', 'default']]);
const D = open();
await sleep(20);
await D.press('6');
f = await D.until((x) => rowOf(x, 'other@example.test') && rowOf(x, 'me@example.test'));
t('a file saying default: its row reads in rotation', rowOf(f, 'other@example.test')?.includes('● in rotation'), true);
t('a file saying unused: its row reads standby', rowOf(f, 'me@example.test')?.includes('○ standby'), true);
D.done();

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all desk-q Usage add-an-account checks passed');
process.exit(fails ? 1 : 0);
