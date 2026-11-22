// suite: desk-q Usage view pins a repo (enter or a click opens its dropdown, 1-N or ↑↓ enter save, esc, u)
// layer: L2
// desk-q's view 6 changing a repo's Subscription row from its dropdown, under a throwaway HOME, DESK_HOME,
// DESK_CONFIG_ROOT, DESK_LOCK_DIR, DESK_USAGE_DIR and subscriptions file, with fake claude and codex
// binaries the account check calls. A pick runs desk-env's subscription set for real, writing the fixture
// repo's config. Drawn at 104 columns under NO_COLOR. One check or more per DS-625 acceptance criterion
// that a key, a click or a save drives.
import { chmodSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('desk-q-usage-pin-');
const H = join(T, 'home');
mkdirSync(join(T, 'bin'));
writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
writeFileSync(join(T, 'bin', 'claude'), '#!/bin/sh\necho \'{"loggedIn": true}\'\n', { mode: 0o755 });
writeFileSync(join(T, 'bin', 'codex'), '#!/bin/sh\necho "Logged in"\n', { mode: 0o755 });
const env = { HOME: H, DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_LOCK_DIR: join(T, 'locks'), DESK_USAGE_DIR: join(T, 'usage'), DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'), DESK_PLATFORM: 'darwin',
  DESK_SKILLS_DIR: join(T, 'skills'), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH', 'DESK_BATCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'DESK_SUBSCRIPTION', 'COLORFGBG', 'COLORTERM', 'NO_COLOR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DESK_AUTOPILOT_WORKER']) delete process.env[k];
Object.assign(process.env, env);
// Each Claude account has a folder of its own, pinned to it (DS-528): ~/.claude is the person's own.
const PERSONAL = join(H, '.claude-logins', 'personal'), WORK = join(H, '.claude-logins', 'work'), SPARE = join(H, '.claude-logins', 'spare');
for (const d of [env.DESK_LOCK_DIR, env.DESK_USAGE_DIR, join(H, '.claude'), PERSONAL, WORK, SPARE, join(H, '.codex')]) mkdirSync(d, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = PERSONAL;
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
const account = (path, email, plan) => writeFileSync(path, JSON.stringify({ oauthAccount: { emailAddress: email, planDisplayName: plan } }));
account(join(PERSONAL, '.claude.json'), 'me@example.test', 'Ultra');
account(join(WORK, '.claude.json'), 'work@example.test', 'Max 5x');
account(join(SPARE, '.claude.json'), 'spare@example.test', 'Pro');
writeFileSync(env.DESK_SUBSCRIPTIONS, '| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n'
  + '| `claude` | `personal` | `~/.claude-logins/personal` | `me@example.test` | `default` |\n| `claude` | `work` | `~/.claude-logins/work` | `work@example.test` | `unused` |\n'
  + '| `claude` | `spare` | `~/.claude-logins/spare` | `spare@example.test` | `unused` |\n| `codex` | `codexmain` | `~/.codex` | `-` | `default` |\n');

// forewatt follows the default: its config has no Subscription row yet.
const CONFIG = join(env.DESK_CONFIG_ROOT, 'repos', 'acme__forewatt', 'config.md');
mkdirSync(dirname(CONFIG), { recursive: true });
writeFileSync(CONFIG, '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `3100` |\n');
const configText = () => readFileSync(CONFIG, 'utf8');
const subRow = () => (/^\| Subscription \| [^|]+ \| `([^`]+)` \|$/m.exec(configText()) ?? [])[1] ?? null;

const Q = await import(join(BIN, 'desk-q.mjs'));
const { PassThrough } = await import('node:stream');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const DOWN = '\x1b[B', ESC = '\x1b';
const FIXED = new Date(2026, 9, 24, 9, 0).getTime();
// desk-env's subscription command run for real, each call counted, so a check can say nothing was written.
const { execFile } = await import('node:child_process');
let writes = 0;
const subscriptionWith = (args, done) => {
  writes++;
  execFile(process.execPath, [join(BIN, 'desk-env.mjs'), 'subscription', ...args], (e, out, err) => done({ code: e ? (e.code ?? 1) : 0, out, err }));
};

function open() {
  process.env.NO_COLOR = '1';
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = { buf: '', columns: 104, rows: 60, write(s) { this.buf += s; }, on() {}, removeListener() {} };
  const ui = Q.interactive({ input, output, start: { kind: 'overview', all: false }, exit() {}, refreshMs: 600000, clock: () => FIXED, probeMs: 600000, probeWith: async () => ({ ran: true }), subscriptionWith });
  const frame = () => output.buf.split('\x1b[H').at(-1).split('\r\n').map((l) => plain(l.replace(/\x1b\[J$/, '').replace(/\x1b\[K$/, '')));
  // Each key on its own read, as a terminal sends them; a lone esc once readline's escape timeout passes.
  const press = async (...ks) => { for (const k of ks) { input.write(k); await sleep(k === ESC ? 700 : 40); } };
  const until = async (pred) => { for (let i = 0; i < 500 && !pred(frame()); i++) await sleep(20); return frame(); };
  return { frame, press, until, done() { ui.finish(0); delete process.env.NO_COLOR; } };
}
const rowOf = (f, name) => f.find((l) => l.slice(2).startsWith(`${name} `)) ?? null;
const setOf = (f) => rowOf(f, 'forewatt')?.slice(46, 59).trimEnd() ?? null;
const useOf = (f, name) => rowOf(f, name)?.slice(36, 50).trimEnd() ?? null;
const isOpen = (f) => f.some((l) => l.includes('┌──'));
const saved = (f) => !f.includes('Saving…') && f.some((l) => l.startsWith('✓') || l.startsWith('Not saved:'));
const message = (f) => { const i = f.findIndex((l) => l.startsWith('✓')); return i < 0 ? null : [f[i], f[i + 1]]; };
// view 6, with forewatt selected
async function usage() {
  const u = open();
  await sleep(20);
  await u.press('6');
  await u.until((x) => x.some((l) => l.startsWith('  Read at') || l.startsWith('  No login')));
  for (let i = 0; i < 8 && !u.frame().find((l) => l.startsWith('›'))?.slice(2).startsWith('forewatt '); i++) await u.press(DOWN);
  return u;
}

// ---- AC4, AC5, AC14: 4 pins forewatt to spare, option 4
let S = await usage();
let f = S.frame();
t('forewatt starts on the default', `${setOf(f)} | ${useOf(f, 'spare@example.test')}`, '○ default | ○ unused');
await S.press('\r');
t('enter opens its dropdown', isOpen(S.frame()), true);
await S.press('4');
f = await S.until(saved);
t('AC4 4: forewatt\'s config holds | Subscription | spare@example.test |', subRow(), 'spare@example.test');
t('AC4 the dropdown closes', isOpen(f), false);
t('AC4 its SET reads ● pinned, and spare\'s USE goes up by one', `${setOf(f)} | ${useOf(f, 'spare@example.test')}`, '● pinned | ● 1 repo');
t('AC5 the message lines', message(f)?.join('\n'),
  '✓ forewatt is pinned to spare@example.test. Its next worker starts there. u undoes.\n  Saved to its config as | Subscription | spare@example.test |. Pick Default to unpin.');
t('AC14 a repo row selected after a save: the keys offer u', f.at(-1), '↑↓ select · ←→ or 1–6 view · enter change subscription · a add · u undo · : command · q quit');

// ---- AC10: u puts it back on the default
await S.press('u');
f = await S.until((x) => !x.includes('Saving…') && x.some((l) => l.includes('again.')));
t('AC10 u: forewatt\'s row is default again', subRow(), 'default');
t('AC10 its SET reads ○ default', setOf(f), '○ default');
t('AC10 the message says so', f.includes('forewatt follows the default again.'), true);

// ---- AC6: ↓ to spare and enter, as AC4
await S.press('\r', DOWN, DOWN, DOWN);
t('AC6 ↓ moves the choice down the options', S.frame().some((l) => /│ › spare@example\.test/.test(l)), true);
await S.press('\r');
f = await S.until(saved);
t('AC6 enter: forewatt\'s config holds | Subscription | spare@example.test |', subRow(), 'spare@example.test');
t('AC6 the dropdown closes and its SET reads ● pinned', `${isOpen(f)} | ${setOf(f)}`, 'false | ● pinned');

// ---- AC9: 1 puts a pinned repo back on the default
await S.press('\r');
t('AC3 the ✓ is on spare, not on Default', `${S.frame().some((l) => /│ 1 +Default +→/.test(l))} | ${S.frame().some((l) => /│ 4 +spare@example\.test ✓/.test(l))}`, 'true | true');
await S.press('1');
f = await S.until((x) => !x.includes('Saving…') && x.some((l) => l.startsWith('✓ forewatt follows')));
t('AC9 1: forewatt\'s row is | Subscription | default |', subRow(), 'default');
t('AC9 its SET reads ○ default', setOf(f), '○ default');
t('AC9 the message lines', message(f)?.join('\n'), '✓ forewatt follows the default, me@example.test. u undoes.\n  Saved to its config as | Subscription | default |.');

// ---- AC7: esc closes, the config unchanged
let before = configText(), wrote = writes;
await S.press('\r');
await S.press(ESC);
f = S.frame();
t('AC7 esc closes the dropdown', isOpen(f), false);
t('AC7 and forewatt\'s config is unchanged', `${configText() === before} | ${writes - wrote} writes`, 'true | 0 writes');

// ---- AC11: picking the ✓ option closes it and writes nothing
await S.press('\r', '1');
await sleep(300);
f = S.frame();
t('AC11 1 on the ✓ Default closes the dropdown', isOpen(f), false);
t('AC11 and forewatt\'s config is unchanged, nothing written', `${configText() === before} | ${writes - wrote} writes`, 'true | 0 writes');
t('AC11 with nothing saved', f.includes('Saving…') || saved(f), false);

// ---- AC8: a click on forewatt's RUNS ON cell opens its dropdown
const y = f.indexOf(rowOf(f, 'forewatt')) + 1;
await S.press(`\x1b[<0;${2 + 16 + 3};${y}M`);
f = S.frame();
t('AC8 a click on its RUNS ON cell opens the dropdown under it', `${isOpen(f)} | ${f[y].includes('┌──')}`, 'true | true');

// ---- AC12: a config that cannot be written: Not saved, the row unchanged
// The file and its folder read-only, so neither a write in place nor a rename over it can land.
chmodSync(CONFIG, 0o444);
chmodSync(dirname(CONFIG), 0o555);
await S.press('4');
f = await S.until(saved);
chmodSync(dirname(CONFIG), 0o755);
chmodSync(CONFIG, 0o644);
t('AC12 the message begins Not saved: with the reason', /^Not saved: \S/.test(f.find((l) => l.startsWith('Not saved:')) ?? ''), true);
t('AC12 forewatt\'s row is unchanged', `${subRow()} | ${setOf(f)}`, 'default | ○ default');

// ---- a click beside the box, on an option's line, closes it and picks nothing
await S.press('\r');
f = S.frame();
const line4 = f.findIndex((l) => /│ 4 +spare@example\.test/.test(l)) + 1;
wrote = writes;
await S.press(`\x1b[<0;1;${line4}M`);
await sleep(300);
t('a click left of the box closes the dropdown and writes nothing', `${isOpen(S.frame())} | ${writes - wrote} writes | ${subRow()}`, 'false | 0 writes | default');
S.done();

// ---- a pin to an email no login here has: the pick says there is no undo, and u has nothing to undo
writeFileSync(CONFIG, `${readFileSync(CONFIG, 'utf8').replace(/^\| Subscription \|.*$/m, '| Subscription | x | `gone@example.test` |')}`);
t('forewatt is pinned to an email with no login here', subRow(), 'gone@example.test');
S = await usage();
await S.press('\r', '1');
f = await S.until(saved);
t('picking Default from it says there is no undo', message(f)?.[0], '✓ forewatt follows the default, me@example.test. No undo: gone@example.test isn\'t signed in here.');
await S.press('u');
t('and u has nothing to undo', S.frame().includes('Nothing to undo.'), true);
S.done();

// ---- a pick of an off subscription: Not saved, saying it is off, the row unchanged
writeFileSync(env.DESK_SUBSCRIPTIONS, readFileSync(env.DESK_SUBSCRIPTIONS, 'utf8').replace('| `~/.claude-logins/spare` | `spare@example.test` | `unused` |', '| `~/.claude-logins/spare` | `spare@example.test` | `off` |'));
before = configText();
S = await usage();
await S.press('\r', '4');
f = await S.until(saved);
// The footer is cut to the screen's width; desk-env's whole message is checked in test_repo_subscription.
t('picking an off subscription is not saved, saying it is off', f.find((l) => l.startsWith('Not saved:'))?.startsWith('Not saved: spare@example.test is off (claude spare), so desk starts no new work on it'), true);
t('and forewatt\'s row is unchanged', `${configText() === before} | ${subRow()} | ${setOf(f)}`, 'true | default | ○ default');
S.done();

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all desk-q Usage pin checks passed');
process.exit(fails ? 1 : 0);
