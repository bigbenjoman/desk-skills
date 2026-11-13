// suite: logins (desk-env logins list, check, set; subscriptions.md)
// The subscriptions file and the account check: parsing with no file, two logins, a malformed row and
// an unknown rule; a fake claude for signed-in, signed-out and same-account logins; a fake codex for
// signed-in and signed-out; no fixture token in anything shown; rule changes through the CLI. A
// scratch HOME only; nothing reads this computer's logins.
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readSubscriptions, parseSubscriptions, renderSubscriptions, checkLogins, checkLines, loginJson, setRule, loginEnv, normRule,
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
t('AC5 the second name on one account is refused, naming both', out.includes('claude login-4 refused: login-4 and default are signed in to the same account; desk uses default'), true);
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

// default and unused: read as in rotation and standby, and written back in their own words.
const NEW = ROWS([
  '| `claude` | `default` | `~/.claude` | `off` |',
  '| `claude` | `login-2` | `~/.claude-logins/login-2` | `default` |',
  '| `claude` | `login-3` | `~/.claude-logins/login-3` | `unused` |',
]);
writeFileSync(join(H, '.claude-logins', 'login-2', 'status.json'), JSON.stringify({ loggedIn: true, email: 'work@example.com' }));
claudeIn(join(H, '.claude-logins', 'login-3'), 'three@example.com', 'Pro');
const nw = checkLogins(parseSubscriptions(NEW), { ...fakes, tools: ['claude'] });
const nwOut = checkLines(nw, SUBS);
t('default and unused: both signed in and usable', nw.usable.filter((l) => l.source === 'file').map((l) => l.name).join(), 'login-2,login-3');
t('default and unused: login-2 checked as in rotation', nwOut.some((l) => /^claude\s+login-2\s.*signed in.*in rotation$/.test(l)), true);
t('default and unused: login-3 checked as standby', nwOut.some((l) => /^claude\s+login-3\s.*signed in.*standby$/.test(l)), true);
t('default and unused: the file round-trips in its own words', renderSubscriptions(parseSubscriptions(NEW).logins), renderSubscriptions(parseSubscriptions(renderSubscriptions(parseSubscriptions(NEW).logins)).logins));
t('default and unused: rendered as written', /\| `login-2` \| `~\/\.claude-logins\/login-2` \| `default` \|[\s\S]*\| `login-3` \| `~\/\.claude-logins\/login-3` \| `unused` \|/.test(renderSubscriptions(parseSubscriptions(NEW).logins)), true);
const ruleOf = (name) => (/\| `([^`]+)` \|$/m.exec(readFileSync(SUBS, 'utf8').split('\n').find((l) => l.includes(`\`${name}\``)) ?? '') ?? [])[1];
writeFileSync(SUBS, NEW);
c = await cli('set', 'claude', 'login-3', 'standby');
t('default and unused: set standby writes unused', `${c.rc} ${ruleOf('login-3')} ${ruleOf('login-2')}`, '0 unused default');
c = await cli('set', 'claude', 'login-3', 'in', 'rotation');
t('default and unused: set in rotation makes it the default, the old default unused', `${c.rc} ${ruleOf('login-3')} ${ruleOf('login-2')}`, '0 default unused');
c = await cli('set', 'claude', 'login-2', 'off');
t('default and unused: set off writes off', `${c.rc} ${ruleOf('login-2')} ${ruleOf('login-3')}`, '0 off default');
const legacy = setRule(parseSubscriptions(FILE), { tool: 'claude', name: 'login-3', rule: 'in rotation', check: () => null });
t('today\'s rules alone: set in rotation still writes in rotation and leaves the others', parseSubscriptions(legacy.text).logins.filter((l) => l.tool === 'claude').map((l) => `${l.name}:${l.rule}`).join(), 'default:in rotation,login-2:in rotation,login-3:in rotation,login-4:in rotation');
t('today\'s rules alone: nothing written as default or unused', /`(default|unused)` \|$/m.test(legacy.text), false);

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

console.log(fails ? `${fails} FAILED` : 'all logins checks passed');
process.exit(fails ? 1 : 0);
