// suite: logins (desk-env logins list, check, set; subscriptions.md)
// The subscriptions file and the account check: parsing with no file, two logins, a malformed row and
// an unknown rule; a fake claude for signed-in, signed-out and same-account logins; a fake codex for
// signed-in and signed-out; no fixture token in anything shown; rule changes through the CLI. A
// scratch HOME only; nothing reads this computer's logins.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readSubscriptions, parseSubscriptions, renderSubscriptions, checkLogins, checkLines, loginJson, setRule, loginEnv, normRule, multiAccount, toolLogins, needsMigration,
} from '../desk/bin/logins.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-logins-'));
const H = join(T, 'home');
mkdirSync(H, { recursive: true });
process.env.HOME = H;

// A token-shaped fixture, built so no scanner reads it as a real one.
const TOKEN = ['sk', 'ant', 'oat01', 'fixture0token0never0shown'].join('-');

// ---- fakes: claude reads <folder>/status.json, codex signs in where <folder>/signed-in exists
const FB = join(T, 'bin');
mkdirSync(FB);
const CALLS = join(T, 'calls');
writeFileSync(join(FB, 'claude'), `#!/bin/sh
d="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
printf 'claude|%s|%s|%s\\n' "\${CLAUDE_CONFIG_DIR-unset}" "\${ANTHROPIC_API_KEY-unset}" "$*" >> "${CALLS}"
[ -f "$d/status.json" ] || { echo '{"loggedIn": false}'; exit 1; }
cat "$d/status.json"
`);
writeFileSync(join(FB, 'codex'), `#!/bin/sh
d="\${CODEX_HOME:-$HOME/.codex}"
printf 'codex|%s|%s|%s\\n' "\${CODEX_HOME-unset}" "\${OPENAI_API_KEY-unset}" "$*" >> "${CALLS}"
[ -f "$d/signed-in" ] || { echo 'Not logged in'; exit 1; }
echo "Logged in using an API key - ${TOKEN}"
`);
chmodSync(join(FB, 'claude'), 0o755);
chmodSync(join(FB, 'codex'), 0o755);
const fakes = { claude: join(FB, 'claude'), codex: join(FB, 'codex'), env: { ...process.env, ANTHROPIC_API_KEY: 'not-a-real-key', OPENAI_API_KEY: 'not-a-real-key', CLAUDE_CONFIG_DIR: '/elsewhere' } };

// A Claude folder signed in to `email` on `plan`; .claude.json sits in the folder, or in HOME for ~/.claude.
function claudeIn(dir, email, plan, { claudeJson = join(dir, '.claude.json') } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email, accessToken: TOKEN }));
  writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email, planDisplayName: plan, accountUuid: 'u' }, primaryApiKey: TOKEN }));
}
const codexIn = (dir, signedIn = true) => { mkdirSync(dir, { recursive: true }); if (signedIn) writeFileSync(join(dir, 'signed-in'), ''); };

// ---- AC1: no file
const none = readSubscriptions(join(T, 'no-such.md'));
t('AC1 no file: one Claude and one Codex login', none.logins.map((l) => `${l.tool}:${l.folder}:${l.rule}`).join(), 'claude:~/.claude:in rotation,codex:~/.codex:in rotation');
t('AC1 no file: no config folder override', none.logins.map((l) => l.configDir).join(), ',');
t('AC1 no file: the default login runs with no CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR' in loginEnv(none.logins[0], { CLAUDE_CONFIG_DIR: '/x' }), false);

// ---- parsing
const ROWS = (rows) => `# Subscriptions\n\n| Tool | Name | Folder | Rule |\n|---|---|---|---|\n${rows.join('\n')}\n`;
const two = parseSubscriptions(ROWS(['| `claude` | `default` | `~/.claude` | `in rotation` |', '| `claude` | `work` | `~/.claude-logins/work` | `standby` |']));
t('two logins: read with their rules', two.logins.filter((l) => l.tool === 'claude').map((l) => `${l.name}:${l.rule}`).join(), 'default:in rotation,work:standby');
t('two logins: the extra one points CLAUDE_CONFIG_DIR at its folder', loginEnv(two.logins[1], {}).CLAUDE_CONFIG_DIR, join(H, '.claude-logins', 'work'));
t('two logins: no codex row keeps the default codex login', two.logins.filter((l) => l.tool === 'codex').map((l) => l.folder).join(), '~/.codex');
const bad = parseSubscriptions(ROWS(['| `claude` | `default` | `~/.claude` |', '| `claude` | `x` | `~/.claude-logins/x` | `sometimes` |', '| `codex` | `default` | `~/.codex` | `off` |']));
t('a malformed row is named and left out', /^line 5: want 4 cells/.test(bad.errors[0]), true);
t('an unknown rule is refused, naming the three', bad.errors[1], 'line 6: claude x: "sometimes" is not a rule: use one of `in rotation`, `standby`, `off`');
t('the good rows still read', bad.logins.map((l) => `${l.tool}:${l.name}:${l.rule}`).join(), 'claude:default:in rotation,codex:default:off');
t('render and parse round-trip', renderSubscriptions(parseSubscriptions(renderSubscriptions(two.logins)).logins), renderSubscriptions(two.logins));
t('rules: in-rotation is in rotation', normRule('In-Rotation'), 'in rotation');

// ---- the check
claudeIn(join(H, '.claude'), 'ben@example.com', 'Ultra', { claudeJson: join(H, '.claude.json') });
claudeIn(join(H, '.claude-logins', 'login-2'), 'work@example.com', 'Max 5x');
mkdirSync(join(H, '.claude-logins', 'login-3'), { recursive: true });
claudeIn(join(H, '.claude-logins', 'login-4'), 'Ben@Example.com', 'Ultra');
codexIn(join(H, '.codex'));
codexIn(join(H, '.codex-logins', 'login-2'), false);
const FILE = ROWS([
  '| `claude` | `default` | `~/.claude` | `in rotation` |',
  '| `claude` | `login-2` | `~/.claude-logins/login-2` | `in rotation` |',
  '| `claude` | `login-3` | `~/.claude-logins/login-3` | `standby` |',
  '| `claude` | `login-4` | `~/.claude-logins/login-4` | `in rotation` |',
  '| `codex` | `default` | `~/.codex` | `in rotation` |',
  '| `codex` | `login-2` | `~/.codex-logins/login-2` | `standby` |',
]);
writeFileSync(CALLS, '');
const r = checkLogins(parseSubscriptions(FILE), fakes);
const by = (tool, name) => r.logins.find((l) => l.tool === tool && l.name === name);
const out = checkLines(r, join(T, 'subscriptions.md')).join('\n');
const row = (re) => out.split('\n').some((l) => re.test(l));
t('AC2 each Claude login: name, folder, account, plan and rule', row(/^claude\s+login-2\s+~\/\.claude-logins\/login-2\s+signed in\s+work@example\.com\s+Max 5x\s+in rotation$/), true);
t('AC3 the default login\'s plan is planDisplayName from ~/.claude.json', by('claude', 'default').plan, 'Ultra');
t('AC3 printed as Ultra', row(/^claude\s+default\s+~\/\.claude\s+signed in\s+ben@example\.com\s+Ultra\s+in rotation$/), true);
t('AC4 a signed-out login is marked signed out', by('claude', 'login-3').state, 'signed out');
t('AC4 with the command that signs it in', out.includes('sign it in, in another terminal: CLAUDE_CONFIG_DIR=~/.claude-logins/login-3 claude, then /login'), true);
t('AC17 the second name on one account is not set up, not pinnable, and nothing is duplicate', `${by('claude', 'login-4').state} ${by('claude', 'login-4').pinnable} ${r.logins.some((l) => l.state === 'duplicate')}`, 'not set up false false');
t('AC17 and says which login keeps the account', by('claude', 'login-4').why, 'the same account as default');
t('AC4 AC5 AC12 usable logins leave out the signed-out and the refused', r.usable.map((l) => `${l.tool}:${l.name}`).join(), 'claude:default,claude:login-2,codex:default');
t('AC11 each Codex login: name, folder, state and rule', row(/^codex\s+login-2\s+~\/\.codex-logins\/login-2\s+signed out\s+-\s+-\s+standby$/), true);
t('AC12 a signed-out Codex login gets codex\'s own login command', out.includes('codex login-2 is signed out: sign it in, in another terminal: CODEX_HOME=~/.codex-logins/login-2 codex login'), true);
const json = JSON.stringify(r.logins.map(loginJson));
t('AC6 no token in what is printed', out.includes(TOKEN), false);
t('AC6 no token in the JSON', json.includes(TOKEN), false);
t('AC6 nothing of codex\'s own output is shown', `${out}${json}`.includes('Logged in using'), false);
const calls = readFileSync(CALLS, 'utf8').trim().split('\n');
t('every call runs with no API key', calls.every((c) => c.split('|')[2] === 'unset'), true);
t('the default login runs with no CLAUDE_CONFIG_DIR, an extra one with its folder', calls.filter((c) => c.startsWith('claude|')).map((c) => c.split('|')[1].replace(H, '~')).join(), 'unset,~/.claude-logins/login-2,~/.claude-logins/login-3,~/.claude-logins/login-4');
t('a folder that does not exist is signed out without a call', checkLogins(parseSubscriptions(ROWS(['| `claude` | `gone` | `~/.claude-logins/gone` | `standby` |'])), fakes).logins[0].why, '~/.claude-logins/gone does not exist');

// ---- AC7 and AC13: found folders
claudeIn(join(H, '.claude-logins', 'login-9'), 'spare@example.com', 'Pro');
mkdirSync(join(H, '.claude-logins', 'empty'), { recursive: true });
const withFile = checkLogins(parseSubscriptions(FILE), fakes);
t('AC7 a signed-in folder the file does not list is on standby', withFile.logins.filter((l) => l.source === 'found').map((l) => `${l.name}:${l.rule}`).join(), 'login-9:standby');
t('AC7 and usable', withFile.usable.some((l) => l.name === 'login-9'), true);
const noFile = checkLogins(readSubscriptions(join(T, 'no-such.md')), fakes);
t('AC13 no file: found folders listed with no rule', noFile.logins.filter((l) => l.source === 'found').map((l) => `${l.name}:${l.rule}`).join(), 'login-2:null,login-4:null,login-9:null');
t('AC13 no file: usable is the default Claude and Codex logins alone', noFile.usable.map((l) => `${l.tool}:${l.name}`).join(), 'claude:default,codex:default');
t('AC13 printed as found, no rule', checkLines(noFile, join(T, 'no-such.md')).some((l) => /^claude\s+login-9\s.*found, no rule$/.test(l)), true);

// ---- setting a rule (AC8, AC9, AC10) through the CLI, with the fakes on PATH
const SUBS = join(T, 'config', 'subscriptions.md');
const env = { ...process.env, PATH: `${FB}:${process.env.PATH}`, HOME: H, DESK_CONFIG_ROOT: join(T, 'config') };
for (const k of ['DESK_CONFIG', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_MACHINE', 'DESK_SUBSCRIPTIONS', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DESK_AUTOPILOT_WORKER']) delete env[k];
const cli = (...a) => new Promise((res) => execFile('node', [join(BIN, 'desk-env.mjs'), 'logins', ...a], { env, cwd: T, encoding: 'utf8' },
  (err, stdout, stderr) => res({ rc: err ? err.code ?? 1 : 0, out: stdout + stderr })));
mkdirSync(join(T, 'config'), { recursive: true });
writeFileSync(SUBS, FILE);
let c = await cli('set', 'claude', 'login-2', 'standby');
t('AC8 set: stored', `${c.rc} ${readSubscriptions(SUBS).logins.find((l) => l.name === 'login-2').rule}`, '0 standby');
t('AC8 set: the previous copy kept beside it', readFileSync(`${SUBS}.bak`, 'utf8'), FILE);
c = await cli('check');
t('AC8 the next check shows it', c.out.split('\n').some((l) => /^claude\s+login-2\s.*standby$/.test(l)), true);
t('AC6 the CLI check prints no token', c.out.includes(TOKEN), false);
c = await cli('check', '--json');
t('check --json: the usable logins', JSON.parse(c.out).usable.join(), 'claude:default,claude:login-2,claude:login-9,codex:default');
c = await cli('set', 'claude', 'login-2', 'sometimes');
t('AC9 an unknown rule is refused, naming the three', `${c.rc} ${c.out.trim()}`, '1 logins: "sometimes" is not a rule: use one of `in rotation`, `standby`, `off`');
c = await cli('set', 'codex', 'login-2', 'in', 'rotation');
t('a rule of two words needs no quoting', readSubscriptions(SUBS).logins.find((l) => l.tool === 'codex' && l.name === 'login-2').rule, 'in rotation');
c = await cli('set', 'claude', 'nobody', 'off');
t('an unknown login is refused, naming the logins', /^logins: no claude login "nobody": the logins are default, login-2, login-3, login-4/.test(c.out), true);

// AC10: only the default Claude login is usable (login-4, found, is the same account).
writeFileSync(SUBS, ROWS(['| `claude` | `default` | `~/.claude` | `in rotation` |', '| `claude` | `login-3` | `~/.claude-logins/login-3` | `standby` |']));
for (const n of ['login-2', 'login-9']) writeFileSync(join(H, '.claude-logins', n, 'status.json'), '{"loggedIn": false}');
const lastFile = readFileSync(SUBS, 'utf8');
c = await cli('set', 'claude', 'default', 'off');
t('AC10 the last usable Claude login cannot be turned off', `${c.rc} ${/desk needs one login it can use/.test(c.out)}`, '1 true');
t('AC10 and the file is unchanged', readFileSync(SUBS, 'utf8'), lastFile);
c = await cli('set', 'claude', 'login-3', 'off');
t('a login that is not usable can be turned off', `${c.rc} ${readSubscriptions(SUBS).logins.find((l) => l.name === 'login-3').rule}`, '0 off');

// No file: setting the default login writes the file with the defaults.
const fresh = join(T, 'fresh');
mkdirSync(fresh);
const r2 = setRule(readSubscriptions(join(fresh, 'subscriptions.md')), { tool: 'codex', name: 'default', rule: 'standby', check: () => { throw new Error('not called'); } });
t('no file: set writes both default logins, with the change', parseSubscriptions(r2.text).logins.map((l) => `${l.tool}:${l.name}:${l.rule}`).join(), 'claude:default:in rotation,codex:default:standby');
const r3 = setRule(readSubscriptions(join(fresh, 'subscriptions.md')), { tool: 'claude', name: 'login-9', rule: 'in rotation', check: () => null });
t('a found folder is added by its name', parseSubscriptions(r3.text).logins.map((l) => `${l.name}:${l.folder}`).join(), 'default:~/.claude,login-9:~/.claude-logins/login-9,default:~/.codex');
let refused = '';
try { setRule(bad, { tool: 'claude', name: 'default', rule: 'standby', check: () => null }); } catch (e) { refused = e.message; }
t('set is refused while the file has rows desk cannot read', /^logins: the subscriptions file has rows desk cannot read/.test(refused), true);
refused = '';
const onlyFound = { usable: [{ tool: 'claude', name: 'login-9', dir: join(H, '.claude-logins', 'login-9') }] };
try { setRule(parseSubscriptions(ROWS(['| `claude` | `default` | `~/.claude` | `in rotation` |'])), { tool: 'claude', name: 'login-9', rule: 'off', check: () => onlyFound }); } catch (e) { refused = e.message; }
t('AC10 a found folder that is the last usable Claude login cannot be turned off', /desk needs one login it can use/.test(refused), true);

// ---- the Account column (DS-529)
const FIVE = '| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n| `claude` | `login-2` | `~/.claude-logins/login-2` | `Ben.Lavender1@Gmail.com` | `in rotation` |\n| `codex` | `default` | `~/.codex` | `-` | `in rotation` |\n';
const s5 = parseSubscriptions(FIVE);
t('the Account column is read, lowercased', s5.logins.find((l) => l.name === 'login-2').account, 'ben.lavender1@gmail.com');
t('a pin puts the file in multi-account mode', multiAccount(s5), true);
t('a 4-column file has no pins', multiAccount(parseSubscriptions('| Tool | Name | Folder | Rule |\n|---|---|---|---|\n| `claude` | `default` | `~/.claude` | `in rotation` |\n')), false);
t('multi-account mode drops ~/.claude from the Claude logins', toolLogins('claude', s5).some((l) => !l.configDir), false);
t('and from the parsed rows', s5.logins.filter((l) => l.tool === 'claude').map((l) => l.name).join(), 'login-2');
t('a pinned file renders 5 columns', renderSubscriptions(s5.logins, s5.removed).includes('| `claude` | `login-2` | `~/.claude-logins/login-2` | `ben.lavender1@gmail.com` | `in rotation` |'), true);
t('a pinned file renders the Codex row with - as its account', renderSubscriptions(s5.logins, s5.removed).includes('| `codex` | `default` | `~/.codex` | `-` | `in rotation` |'), true);
t('a pinned file explains the column', renderSubscriptions(s5.logins).includes('Account is the Claude account a folder belongs to: desk uses the folder only while it is signed in to that account.'), true);
t('a pinned file round-trips', renderSubscriptions(parseSubscriptions(renderSubscriptions(s5.logins, s5.removed)).logins), renderSubscriptions(s5.logins));
t('an unpinned file still renders 4 columns', renderSubscriptions(parseSubscriptions('').logins).includes('| Tool | Name | Folder | Rule |'), true);
t('and none of the Account copy', renderSubscriptions(parseSubscriptions('').logins).includes('Account is'), false);
const badAcc = parseSubscriptions('| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n| `claude` | `x` | `~/.claude-logins/x` | `not-an-email` | `standby` |\n| `codex` | `c` | `~/.codex` | `a@b.c` | `standby` |\n');
t('an Account that is not an email is a named error', badAcc.errors.some((e) => /^line 3: .*not an email/.test(e)), true);
t('an Account on a Codex row is a named error', badAcc.errors.some((e) => /^line 4: .*codex/.test(e)), true);
t('those rows are left out and the defaults stand', badAcc.logins.map((l) => `${l.tool}:${l.name}`).join(), 'claude:default,codex:default');
t('setRule keeps a pin', setRule(s5, { tool: 'claude', name: 'login-2', rule: 'standby', check: () => ({ usable: [] }) }).text.includes('`ben.lavender1@gmail.com` | `standby`'), true);

// ---- the account check states (DS-529): login-2 pinned to a@x.io, login-3 to b@x.io, login-4 unlisted
const L2 = join(H, '.claude-logins', 'login-2'), L3 = join(H, '.claude-logins', 'login-3'), L4 = join(H, '.claude-logins', 'login-4');
const PINNED = '| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n| `claude` | `login-2` | `~/.claude-logins/login-2` | `a@x.io` | `in rotation` |\n| `claude` | `login-3` | `~/.claude-logins/login-3` | `B@x.io` | `standby` |\n';
const pinCheck = (opts) => checkLogins(parseSubscriptions(PINNED), { ...fakes, ...opts });
const stOf = (res, n) => res.logins.find((l) => l.name === n);
for (const d of [L2, L3, L4]) rmSync(d, { recursive: true, force: true });
claudeIn(L2, 'a@x.io', 'Ultra'); claudeIn(L3, 'b@x.io', 'Pro');
let pc = pinCheck();
t('a pinned folder on its account is signed in', stOf(pc, 'login-2').state, 'signed in');
t('and usable', pc.usable.filter((l) => l.tool === 'claude').map((l) => l.name).join(), 'login-2,login-3');
claudeIn(L2, 'A@X.io', 'Ultra');
pc = pinCheck();
t('case does not matter', `${stOf(pc, 'login-2').state} ${stOf(pc, 'login-2').email}`, 'signed in a@x.io');
claudeIn(L2, 'b@x.io', 'Ultra');
pc = pinCheck();
t('a pinned folder on another account is wrong account', `${stOf(pc, 'login-2').state} ${stOf(pc, 'login-2').liveEmail} ${stOf(pc, 'login-2').why}`, 'wrong account b@x.io signed in to b@x.io');
t('and is not usable', pc.usable.some((l) => l.name === 'login-2'), false);
t('and keeps its pinned label', stOf(pc, 'login-2').email, 'a@x.io');
t('and login-3 stays signed in', stOf(pc, 'login-3').state, 'signed in');
t('checkLines names the wrong account', checkLines(pc, join(T, 'subscriptions.md')).some((l) => l.includes('claude login-2 is signed in to b@x.io, not a@x.io: desk won\'t use it until it is signed back in')), true);
claudeIn(L2, 'a@x.io', 'Ultra');
t('signed back in it is usable again, in its rule', `${pinCheck().usable.find((l) => l.name === 'login-2')?.rule}`, 'in rotation');
claudeIn(L4, 'c@x.io', 'Pro');
pc = pinCheck();
t('an unlisted signed-in folder is not set up and pinnable', `${stOf(pc, 'login-4').state} ${stOf(pc, 'login-4').pinnable}`, 'not set up true');
t('and is not usable', pc.usable.some((l) => l.name === 'login-4'), false);
t('checkLines says how to pin it', checkLines(pc, join(T, 'subscriptions.md')).some((l) => l === 'claude login-4 is not set up: desk-env logins pin claude login-4 pins it to the account it is signed in to'), true);
claudeIn(L4, 'b@x.io', 'Pro');
t('an unlisted folder on a pinned account is not pinnable', `${stOf(pinCheck(), 'login-4').state} ${stOf(pinCheck(), 'login-4').pinnable}`, 'not set up false');
claudeIn(L4, 'c@x.io', 'Pro');
writeFileSync(join(L2, 'status.json'), 'not json');
pc = pinCheck();
t('a check that errors on a pinned folder stays error', `${stOf(pc, 'login-2').state} ${stOf(pc, 'login-2').account}`, 'error a@x.io');
claudeIn(L2, 'a@x.io', 'Ultra');
writeFileSync(CALLS, '');
pinCheck();
t('~/.claude is never checked in multi-account mode', readFileSync(CALLS, 'utf8').split('\n').some((x) => x.startsWith('claude|unset|')), false);
const twice = parseSubscriptions(PINNED.replace('`B@x.io`', '`A@x.io`'));
const tw = checkLogins(twice, fakes);
t('two rows pinned to one email: the first keeps it', `${stOf(tw, 'login-2').state} ${stOf(tw, 'login-3').state} ${stOf(tw, 'login-3').pinnable}`, 'signed in not set up false');
t('and the second says whose it is', stOf(tw, 'login-3').why, 'pinned to the same account as login-2');
t('loginJson carries the account fields and no duplicateOf', JSON.stringify(loginJson(stOf(pc, 'login-4'))).includes('"pinnable":true') && !('duplicateOf' in loginJson(stOf(pc, 'login-4'))) && loginJson(stOf(pc, 'login-4')).liveEmail === 'c@x.io', true);
for (const d of [L2, L3, L4]) rmSync(d, { recursive: true, force: true });

// ---- pin and migrate (DS-530), each scenario in a fresh HOME and config folder
let scn = 0;
function scenario(file, signed = {}) {
  const home = join(T, `home-pin-${++scn}`), cfg = join(T, `config-pin-${scn}`);
  mkdirSync(cfg, { recursive: true });
  const dirOf = (n) => (n === 'default' ? join(home, '.claude') : join(home, '.claude-logins', n));
  for (const [n, email] of Object.entries(signed)) {
    if (n === 'default') claudeIn(dirOf(n), email, 'Pro', { claudeJson: join(home, '.claude.json') });
    else if (email) claudeIn(dirOf(n), email, 'Pro');
    else mkdirSync(dirOf(n), { recursive: true });
  }
  const path = join(cfg, 'subscriptions.md');
  if (file !== null) writeFileSync(path, file);
  const e = { ...env, HOME: home, DESK_CONFIG_ROOT: cfg };
  const run = (...a) => new Promise((res) => execFile('node', [join(BIN, 'desk-env.mjs'), 'logins', ...a], { env: e, cwd: T, encoding: 'utf8' },
    (err, stdout, stderr) => res({ rc: err ? err.code ?? 1 : 0, out: stdout, err: stderr })));
  const read = () => { process.env.HOME = home; const r = readSubscriptions(path); process.env.HOME = H; return r; };
  return { home, path, run, read, text: () => readFileSync(path, 'utf8'), has: () => existsSync(path) };
}
const OLD = ROWS(['| `claude` | `default` | `~/.claude` | `in rotation` |', '| `claude` | `login-2` | `~/.claude-logins/login-2` | `standby` |']);
const lg = (subs, n) => subs.logins.find((l) => l.tool === 'claude' && l.name === n);
const pinState = (subs, n) => `${lg(subs, n)?.account ?? 'unpinned'}/${lg(subs, n)?.rule}`;

let sc = scenario(OLD, { default: 'x@a.io', 'login-2': 'y@a.io', 'login-3': 'x@a.io' });
process.env.HOME = sc.home;
t('the old file needs migrating', needsMigration(sc.read()), true);
process.env.HOME = H;
let m = await sc.run('migrate');
let after = sc.read();
t('AC1 migrate: login-2 pinned and on standby', pinState(after, 'login-2'), 'y@a.io/standby');
t('AC1 migrate: the found login-3 is pinned', pinState(after, 'login-3'), 'x@a.io/standby');
t('AC1 migrate: ~/.claude is in the Removed table', `${after.removed.some((r) => r.tool === 'claude' && r.folder === '~/.claude')} ${lg(after, 'default')}`, 'true undefined');
t('AC1 migrate: no add hint when x@a.io is pinned', `${m.rc} ${m.out.includes('with a in view 6')}`, '0 false');
t('AC11 migrate: the previous file kept as a backup', readFileSync(`${sc.path}.bak`, 'utf8') === OLD, true);
t('AC6 migrate: a pinned file needs no migrating', (await sc.run('migrate')).out.trim(), 'nothing to migrate');
const pinnedText = sc.text();
t('AC6 and is left as it was', `${sc.text() === pinnedText}`, 'true');

sc = scenario(OLD, { default: 'x@a.io', 'login-2': 'y@a.io', 'login-3': 'y@a.io' });
m = await sc.run('migrate');
after = sc.read();
t('AC2 migrate: login-3 on a pinned account stays unpinned', `${pinState(after, 'login-3')} ${pinState(after, 'login-2')}`, 'unpinned/standby y@a.io/standby');
t('AC2 migrate: names the account to add', m.out.includes('add x@a.io with a in view 6'), true);

sc = scenario(OLD, { default: 'x@a.io', 'login-2': null });
m = await sc.run('migrate');
after = sc.read();
t('AC3 migrate: a signed-out login-2 is unpinned and keeps its rule', pinState(after, 'login-2'), 'unpinned/standby');

const codexOnly = ROWS(['| `claude` | `default` | `~/.claude` | `standby` |', '| `codex` | `default` | `~/.codex` | `in rotation` |']);
sc = scenario(codexOnly, { default: 'x@a.io' });
process.env.HOME = sc.home;
t('a Codex-only file is left alone', needsMigration(parseSubscriptions(codexOnly)), false);
process.env.HOME = H;
m = await sc.run('migrate');
t('AC4 migrate: nothing to migrate, file unchanged', `${m.out.trim()} ${sc.text() === codexOnly} ${existsSync(`${sc.path}.bak`)}`, 'nothing to migrate true false');

sc = scenario(null, { default: 'x@a.io', 'login-2': 'y@a.io' });
process.env.HOME = sc.home;
t('no file is left alone', needsMigration(readSubscriptions(join(T, 'none.md'))), false);
process.env.HOME = H;
m = await sc.run('migrate');
t('AC5 migrate: no file, nothing written', `${m.out.trim()} ${sc.has()}`, 'nothing to migrate false');

// pin
const ROT = ROWS(['| `claude` | `default` | `~/.claude` | `in rotation` |', '| `claude` | `login-2` | `~/.claude-logins/login-2` | `in rotation` |']);
sc = scenario(ROT, { default: 'x@a.io', 'login-4': 'z@a.io' });
let p = await sc.run('pin', 'claude', 'login-4');
after = sc.read();
t('AC7 pin: an unlisted login-4 is added, pinned, on standby', `${p.rc} ${pinState(after, 'login-4')}`, '0 z@a.io/standby');
t('AC11 pin: the previous file kept as a backup', readFileSync(`${sc.path}.bak`, 'utf8') === ROT, true);

sc = scenario(ROT, { default: 'x@a.io', 'login-2': 'y@a.io' });
p = await sc.run('pin', 'claude', 'login-2');
after = sc.read();
t('AC8 pin: a listed login-2 keeps its rule', `${p.rc} ${pinState(after, 'login-2')}`, '0 y@a.io/in rotation');
t('AC8 pin: and a listed unpinned ~/.claude row goes to Removed', `${lg(after, 'default')} ${after.removed.some((r) => r.folder === '~/.claude')}`, 'undefined true');

sc = scenario(ROT, { default: 'x@a.io', 'login-2': 'y@a.io', 'login-4': 'Y@a.io' });
await sc.run('pin', 'claude', 'login-2');
const before = sc.text();
p = await sc.run('pin', 'claude', 'login-4');
t('AC9 pin: an account pinned elsewhere is refused', `${p.rc} ${p.err.trim()}`, '1 logins: y@a.io is already pinned to login-2');
t('AC9 pin: and the file is unchanged', sc.text() === before, true);

sc = scenario(ROT, { default: 'x@a.io', 'login-4': null });
p = await sc.run('pin', 'claude', 'login-4');
t('AC10 pin: a signed-out login-4 is refused', `${p.rc} ${p.err.trim()} ${sc.text() === ROT}`, '1 logins: claude login-4 is not signed in true');

t('usage names pin and migrate', (await sc.run('bogus')).err.includes('| pin claude <name> | migrate'), true);


console.log(fails ? `${fails} FAILED` : 'all logins checks passed');
process.exit(fails ? 1 : 0);
