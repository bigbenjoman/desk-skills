// suite: logins (desk-env logins list, check, set; subscriptions.md)
// layer: L2
// The subscriptions file and the account check: parsing with no file, two logins, a malformed row and
// an unknown rule; a fake claude for signed-in, signed-out and same-account logins; a fake codex for
// signed-in and signed-out; no fixture token in anything shown; rule changes through the CLI. A
// scratch HOME only; nothing reads this computer's logins.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readSubscriptions, parseSubscriptions, renderSubscriptions, checkLogins, checkLines, loginJson, setRule, removeLogin, loginEnv, normRule, multiAccount, toolLogins, needsPinMigration, codexAccount, today,
} from '../desk/bin/logins.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('desk-logins-');
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
[ -f "$d/hang" ] && kill -KILL $$
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
let c = await cli('set', 'claude', 'login-2', 'unused');
t('AC8 set: stored', `${c.rc} ${readSubscriptions(SUBS).logins.find((l) => l.name === 'login-2').rule} ${c.out.trim().split('\n').at(-1)}`, '0 standby claude login-2: unused');
t('AC8 set: the previous copy kept beside it', readFileSync(`${SUBS}.bak`, 'utf8'), FILE);
c = await cli('check');
t('AC8 the next check shows it', c.out.split('\n').some((l) => /^claude\s+login-2\s.*standby$/.test(l)), true);
t('AC6 the CLI check prints no token', c.out.includes(TOKEN), false);
c = await cli('check', '--json');
t('check --json: the usable logins', JSON.parse(c.out).usable.join(), 'claude:default,claude:login-2,claude:login-9,codex:default');
// DS-532 AC8: a Codex auth.json with an id_token, an access token and a refresh token; the check's JSON
// carries the id_token's email and plan, and neither other token's text.
const ACCESS = ['access', 'fixture0token0never0shown'].join('-'), REFRESH = ['refresh', 'fixture0token0never0shown'].join('-');
const idToken = (payload) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
writeFileSync(join(H, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: {
  id_token: idToken({ email: 'me@x.io', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }), access_token: ACCESS, refresh_token: REFRESH, account_id: 'a' } }));
c = await cli('check', '--json');
const codexJson = JSON.parse(c.out).logins.find((l) => l.tool === 'codex' && l.name === 'default');
t('DS-532 AC8 the check\'s JSON names the Codex login\'s email and plan from its id_token', `${codexJson.email} ${codexJson.plan}`, 'me@x.io Pro');
t('DS-532 AC8 and neither the access nor the refresh token\'s text', c.out.includes(ACCESS) || c.out.includes(REFRESH), false);
const cxDefault = toolLogins('codex', parseSubscriptions(FILE))[0];
const authIs = (body) => { writeFileSync(join(H, '.codex', 'auth.json'), typeof body === 'string' ? body : JSON.stringify(body)); return JSON.stringify(codexAccount(cxDefault)); };
const NONE = JSON.stringify({ email: null, plan: null });
t('DS-532 codexAccount: no plan type gives a null plan', authIs({ tokens: { id_token: idToken({ email: 'me@x.io' }) } }), JSON.stringify({ email: 'me@x.io', plan: null }));
t('DS-532 codexAccount: an API key only gives nothing', authIs({ OPENAI_API_KEY: 'k' }), NONE);
t('DS-532 codexAccount: an id_token of two parts gives nothing', authIs({ tokens: { id_token: 'a.b' } }), NONE);
t('DS-532 codexAccount: an id_token whose middle does not decode gives nothing', authIs({ tokens: { id_token: 'a.!!!.c' } }), NONE);
t('DS-532 codexAccount: an auth.json that is not JSON gives nothing', authIs('{not json'), NONE);
rmSync(join(H, '.codex', 'auth.json'));
t('DS-532 codexAccount: no auth.json gives nothing', JSON.stringify(codexAccount(cxDefault)), NONE);
c = await cli('set', 'claude', 'login-2', 'sometimes');
t('AC9 an unknown rule is refused, naming the two and the default', `${c.rc} ${c.out.trim()}`, '1 logins: "sometimes" is not a rule: choose the default with desk-env logins default claude <name>, and set any other login `unused` or `off`');
// DS-630 AC3, AC4: the older rules are refused, naming desk-env logins default, and nothing is written.
const kept = readFileSync(SUBS, 'utf8');
for (const [ac, rule] of [['AC3', ['in', 'rotation']], ['AC3', ['in rotation']], ['AC4', ['standby']], ['AC4', ['Standby']]]) {
  const held = readFileSync(SUBS, 'utf8');
  c = await cli('set', 'claude', 'login-3', ...rule);
  t(`DS-630 ${ac} set ${rule.join(' ')} is refused, naming desk-env logins default, the file unchanged`, `${c.rc} ${/desk-env logins default claude <name>/.test(c.out)} ${/is not a rule desk sets any more/.test(c.out)} ${readFileSync(SUBS, 'utf8') === held}`, '1 true true true');
}
for (const [what, text] of [['an unreadable', ROWS(['| `claude` | `default` | `~/.claude` |'])], ['a default-and-unused', ROWS(['| `claude` | `login-2` | `~/.claude-logins/login-2` | `default` |', '| `claude` | `login-3` | `~/.claude-logins/login-3` | `unused` |'])]]) {
  writeFileSync(SUBS, text);
  c = await cli('set', 'claude', 'login-3', 'in', 'rotation');
  t(`DS-630 AC3 in ${what} file set in rotation is refused as well, the file unchanged`, `${c.rc} ${/desk-env logins default claude <name>/.test(c.out)} ${readFileSync(SUBS, 'utf8') === text}`, '1 true true');
}
writeFileSync(SUBS, kept);
c = await cli('set', 'codex', 'login-2', 'Unused');
t('a rule in any case is read', `${c.rc} ${readSubscriptions(SUBS).logins.find((l) => l.tool === 'codex' && l.name === 'login-2').rule} ${c.out.trim().split('\n').at(-1)}`, '0 standby codex login-2: unused');
for (const word of ['constructor', 'toString', '__proto__']) {
  const held = readFileSync(SUBS, 'utf8');
  c = await cli('set', 'claude', 'login-3', word);
  t(`set ${word} is refused as an unknown rule, the file unchanged`, `${c.rc} ${c.out.includes(`"${word}" is not a rule:`)} ${readFileSync(SUBS, 'utf8') === held}`, '1 true true');
}
c = await cli('set', 'claude', 'nobody', 'off');
t('an unknown login is refused, naming the logins', /^logins: no claude login "nobody": the logins are default, login-2, login-3, login-4/.test(c.out), true);

// AC10: only the default Claude login is usable (login-4, found, is the same account).
// login-2, signed out below, is the default list shows, so ~/.claude is not: the default is never turned off.
writeFileSync(SUBS, ROWS(['| `claude` | `login-2` | `~/.claude-logins/login-2` | `in rotation` |', '| `claude` | `default` | `~/.claude` | `standby` |', '| `claude` | `login-3` | `~/.claude-logins/login-3` | `standby` |']));
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
t('default and unused: login-2 checked as default', nwOut.some((l) => /^claude\s+login-2\s.*signed in.*default$/.test(l)), true);
t('default and unused: login-3 checked as unused', nwOut.some((l) => /^claude\s+login-3\s.*signed in.*unused$/.test(l)), true);
t('default and unused: the file round-trips in its own words', renderSubscriptions(parseSubscriptions(NEW).logins), renderSubscriptions(parseSubscriptions(renderSubscriptions(parseSubscriptions(NEW).logins)).logins));
t('default and unused: rendered as written', /\| `login-2` \| `~\/\.claude-logins\/login-2` \| `default` \|[\s\S]*\| `login-3` \| `~\/\.claude-logins\/login-3` \| `unused` \|/.test(renderSubscriptions(parseSubscriptions(NEW).logins)), true);
const ruleOf = (name) => (/\| `([^`]+)` \|$/m.exec(readFileSync(SUBS, 'utf8').split('\n').find((l) => l.includes(`\`${name}\``)) ?? '') ?? [])[1];
writeFileSync(SUBS, NEW);
c = await cli('set', 'claude', 'login-3', 'unused');
t('default and unused: set unused writes unused', `${c.rc} ${ruleOf('login-3')} ${ruleOf('login-2')}`, '0 unused default');
c = await cli('default', 'claude', 'login-3');
t('default and unused: default makes it the default, the old default unused', `${c.rc} ${ruleOf('login-3')} ${ruleOf('login-2')}`, '0 default unused');
c = await cli('set', 'claude', 'login-2', 'off');
t('default and unused: set off writes off', `${c.rc} ${ruleOf('login-2')} ${ruleOf('login-3')}`, '0 off default');
const legacy = setRule(parseSubscriptions(FILE), { tool: 'claude', name: 'login-2', rule: 'unused', check: () => null });
t('today\'s rules alone: set unused writes standby and leaves the others', parseSubscriptions(legacy.text).logins.filter((l) => l.tool === 'claude').map((l) => `${l.name}:${l.rule}`).join(), 'default:in rotation,login-2:standby,login-3:standby,login-4:in rotation');
let refusedRule = '';
try { setRule(parseSubscriptions(FILE), { tool: 'claude', name: 'login-3', rule: 'in rotation', check: () => null }); } catch (e) { refusedRule = e.message; }
t('DS-630 AC3 setRule itself refuses in rotation, naming desk-env logins default', /is not a rule desk sets any more: choose the default with desk-env logins default claude <name>/.test(refusedRule), true);
t('today\'s rules alone: nothing written as default or unused', /`(default|unused)` \|$/m.test(legacy.text), false);

// No file: the default list shows is refused as one the file marks default, and setting another login
// writes the file with the defaults.
const fresh = join(T, 'fresh');
mkdirSync(fresh);
let refused = '';
try { setRule(readSubscriptions(join(fresh, 'subscriptions.md')), { tool: 'codex', name: 'default', rule: 'unused', check: () => { throw new Error('not called'); } }); } catch (e) { refused = e.message; }
t('no file: the default list shows cannot be set unused', /^logins: codex default is the Codex default: make another subscription the default first/.test(refused), true);
const r3 = setRule(readSubscriptions(join(fresh, 'subscriptions.md')), { tool: 'claude', name: 'login-9', rule: 'unused', check: () => null });
t('a found folder is added by its name', parseSubscriptions(r3.text).logins.map((l) => `${l.name}:${l.folder}`).join(), 'default:~/.claude,login-9:~/.claude-logins/login-9,default:~/.codex');
// A file in today's rules, not yet listed: its first login in rotation is the default list shows.
const unlisted = parseSubscriptions(ROWS(['| `claude` | `login-2` | `~/.claude-logins/login-2` | `in rotation` |', '| `claude` | `login-3` | `~/.claude-logins/login-3` | `in rotation` |']));
refused = '';
try { setRule(unlisted, { tool: 'claude', name: 'login-2', rule: 'off', check: () => null }); } catch (e) { refused = e.message; }
t('today\'s rules: the first login in rotation cannot be turned off', /is the Claude default: make another/.test(refused), true);
refused = '';
try { removeLogin(unlisted, { tool: 'claude', name: 'login-2', check: () => null }); } catch (e) { refused = e.message; }
t('today\'s rules: nor removed', /is the Claude default: make another/.test(refused), true);
t('today\'s rules: another login in rotation can be', setRule(unlisted, { tool: 'claude', name: 'login-3', rule: 'unused', check: () => null }).login.rule, 'standby');
refused = '';
try { setRule(bad, { tool: 'claude', name: 'default', rule: 'unused', check: () => null }); } catch (e) { refused = e.message; }
t('set is refused while the file has rows desk cannot read', /^logins: the subscriptions file has rows desk cannot read/.test(refused), true);
refused = '';
const onlyFound = { usable: [{ tool: 'claude', name: 'login-9', dir: join(H, '.claude-logins', 'login-9') }] };
try { setRule(parseSubscriptions(ROWS(['| `claude` | `default` | `~/.claude` | `in rotation` |'])), { tool: 'claude', name: 'login-9', rule: 'off', check: () => onlyFound }); } catch (e) { refused = e.message; }
t('AC10 a found folder that is the last usable Claude login cannot be turned off', /desk needs one login it can use/.test(refused), true);

{
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
t('an Account that is not an email is a named error', badAcc.errors.includes('line 3: claude x: account "not-an-email" is not an email'), true);
t('an Account on a Codex row is a named error', badAcc.errors.includes('line 4: codex c: a Codex row takes no account'), true);
const goodAndBad = parseSubscriptions('| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n| `claude` | `x` | `~/.claude-logins/x` | `not-an-email` | `standby` |\n| `claude` | `y` | `~/.claude-logins/y` | `y@x.io` | `standby` |\n');
t('a bad Account leaves the rest read', `${goodAndBad.errors.length} ${goodAndBad.logins.filter((l) => l.tool === 'claude').map((l) => `${l.name}:${l.account}`).join()}`, '1 y:y@x.io');
const mixed = renderSubscriptions([...s5.logins, ...parseSubscriptions('| Tool | Name | Folder | Rule |\n|---|---|---|---|\n| `claude` | `spare` | `~/.claude-logins/spare` | `standby` |\n').logins.filter((l) => l.tool === 'claude')]).split('\n');
t('a pinned file has the 5-column header', mixed.includes('| Tool | Name | Folder | Account | Rule |'), true);
t('an unpinned Claude row beside a pin carries -', mixed.includes('| `claude` | `spare` | `~/.claude-logins/spare` | `-` | `standby` |'), true);
t('no row has an account: the 4-column header, exactly', renderSubscriptions(two.logins).split('\n').includes('| Tool | Name | Folder | Rule |'), true);
t('those rows are left out: Codex keeps its default, Claude none, as the Account column keeps the file pinned', `${badAcc.logins.map((l) => `${l.tool}:${l.name}`).join()} ${multiAccount(badAcc)}`, 'codex:default true');
// A pinned file whose every Claude row fails to read never falls back to ~/.claude, and keeps ~/.claude in Removed.
const allBad = parseSubscriptions('| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n| `claude` | `w` | `~/.claude-logins/w` | `me@localhost` | `in rotation` |\n\n## Removed\n\n| Tool | Name | Folder |\n|---|---|---|\n| `claude` | `default` | `~/.claude` |\n');
t('every pinned row unreadable: no Claude login, still multi-account, ~/.claude stays removed',
  `${allBad.errors.length} ${allBad.logins.some((l) => l.tool === 'claude')} ${multiAccount(allBad)} ${allBad.removed.some((r) => r.folder === '~/.claude')}`, '1 false true true');
// The last pinned account is never removed, signed in or not: the file would leave multi-account mode.
const pinnedPair = '| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n| `claude` | `w` | `~/.claude-logins/w` | `w@x.io` | `in rotation` |\n| `claude` | `v` | `~/.claude-logins/v` | `v@x.io` | `standby` |\n';
const noneUsable = () => ({ usable: [] });
const lastPin = (() => { try { removeLogin(parseSubscriptions(pinnedPair.split('\n').slice(0, 3).join('\n')), { tool: 'claude', name: 'w', check: noneUsable }); return 'removed'; } catch (e) { return e.message; } })();
// Alone it is also the Claude default, which main refuses first (DS-618); either way it stays.
t('the last pinned account, signed out, is not removed', /only Claude account desk has|is the Claude default/.test(lastPin), true);
const pinBesideUnpinned = '| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n| `claude` | `v` | `~/.claude-logins/v` | `-` | `default` |\n| `claude` | `w` | `~/.claude-logins/w` | `w@x.io` | `unused` |\n';
const lastPin2 = (() => { try { removeLogin(parseSubscriptions(pinBesideUnpinned), { tool: 'claude', name: 'w', check: () => ({ usable: [{ tool: 'claude', name: 'v' }] }) }); return 'removed'; } catch (e) { return e.message; } })();
t('the last pinned account, not the default, is not removed either', /only Claude account desk has/.test(lastPin2), true);
const onePin = removeLogin(parseSubscriptions(pinnedPair), { tool: 'claude', name: 'v', check: noneUsable });
t('a pinned account with another pinned beside it is removed', `${multiAccount(parseSubscriptions(onePin.text))} ${parseSubscriptions(onePin.text).logins.filter((l) => l.tool === 'claude').map((l) => l.name).join()}`, 'true w');
t('setRule keeps a pin', setRule(parseSubscriptions(pinnedPair), { tool: 'claude', name: 'v', rule: 'unused', check: () => ({ usable: [] }) }).text.includes('`v@x.io` | `standby`'), true);

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
t('and it is usable', pc.usable.some((l) => l.name === 'login-2'), true);
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
t('and names the login that account is pinned to', stOf(pinCheck(), 'login-4').why, 'the same account as login-3');
t('checkLines gives that reason, not "not signed in"', checkLines(pinCheck(), join(T, 'subscriptions.md')).includes('claude login-4 is not set up: the same account as login-3; desk won\'t use it'), true);
claudeIn(L4, 'c@x.io', 'Pro');
writeFileSync(join(L2, 'status.json'), 'not json');
pc = pinCheck();
t('a check that errors on a pinned folder stays error', `${stOf(pc, 'login-2').state} ${stOf(pc, 'login-2').account}`, 'error a@x.io');
t('and is shown not checked, never wrong account', checkLines(pc, join(T, 'subscriptions.md')).some((l) => /^claude\s+login-2\s.*\snot checked\s/.test(l)), true);
claudeIn(L2, 'a@x.io', 'Ultra');
writeFileSync(join(L2, 'hang'), '');
pc = pinCheck();
t('a check that does not answer on a pinned folder is error too', `${stOf(pc, 'login-2').state} ${stOf(pc, 'login-2').account} ${stOf(pc, 'login-2').why}`, `error a@x.io ${fakes.claude} did not answer within 20s`);
t('and is not usable', pc.usable.some((l) => l.name === 'login-2'), false);
t('and is shown not checked', checkLines(pc, join(T, 'subscriptions.md')).includes(`claude login-2 could not be checked: ${fakes.claude} did not answer within 20s`), true);
rmSync(join(L2, 'hang'));
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
t('the old file needs migrating', needsPinMigration(sc.read()), true);
process.env.HOME = H;
let m = await sc.run('migrate');
let after = sc.read();
t('AC1 migrate: login-2 pinned and unused', `${pinState(after, 'login-2')} ${lg(after, 'login-2').stored}`, 'y@a.io/standby unused');
// ~/.claude was the default: the folder pinned to its account, x@a.io, takes over as the default (DS-616).
t('AC1 migrate: the found login-3 is pinned, and the default as ~/.claude was', `${pinState(after, 'login-3')} ${lg(after, 'login-3').stored}`, 'x@a.io/in rotation default');
t('AC1 migrate: ~/.claude is in the Removed table', `${after.removed.some((r) => r.tool === 'claude' && r.folder === '~/.claude')} ${lg(after, 'default')}`, 'true undefined');
t('AC1 migrate: no add hint when x@a.io is pinned', `${m.rc} ${m.out.includes('with a in view 6')}`, '0 false');
t('#1489 AC3 migrate: ~/.claude is recorded as removed today', after.removed.find((r) => r.folder === '~/.claude')?.at, today());
t('#1489 AC1 migrate: one line names the login moved, why, and how to list it again', m.out.split('\n').filter((l) => l.includes('moved to Removed')).join('\n'),
  'claude default (~/.claude) moved to Removed: once a Claude login is pinned to an account, desk signs in only through pinned folders, never ~/.claude. To list it again: desk-env logins set claude default unused');
t('#1489 AC2 migrate: a before and after for each row whose rule or section changed', m.out.split('\n').filter((l) => / -> /.test(l)).join('\n'),
  'claude default (~/.claude): in rotation -> Removed\nclaude login-2 (~/.claude-logins/login-2): standby -> unused');
const baks = (s) => readdirSync(dirname(s.path)).filter((n) => n.startsWith('subscriptions.md.bak'));
t('AC11 #1489 AC2 migrate: the previous file kept as a dated backup, not .bak', `${baks(sc).length} ${/^subscriptions\.md\.bak-\d{4}-\d\d-\d\dT/.test(baks(sc)[0])} ${readFileSync(join(dirname(sc.path), baks(sc)[0]), 'utf8') === OLD}`, '1 true true');
t('#1489 AC2 and the wrote line names it', m.out.includes(`(previous copy: ${join(dirname(sc.path), baks(sc)[0])})`), true);
const pinnedText = sc.text();
t('AC6 migrate: a pinned file needs no migrating', (await sc.run('migrate')).out.trim(), 'nothing to migrate');
t('AC6 and is left as it was, with no new backup', `${sc.text() === pinnedText} ${baks(sc).length}`, 'true 1');

// #1489 Verification: ~/.claude listed unused beside a default under ~/.claude-logins
const UNUSED = ROWS(['| `claude` | `default` | `~/.claude` | `unused` |', '| `claude` | `login-2` | `~/.claude-logins/login-2` | `default` |']);
sc = scenario(UNUSED, { default: 'x@a.io', 'login-2': 'y@a.io' });
m = await sc.run('migrate');
after = sc.read();
t('#1489 migrate: the pinned login-2 keeps its rule', `${pinState(after, 'login-2')} ${lg(after, 'login-2').stored}`, 'y@a.io/in rotation default');
t('#1489 migrate: ~/.claude at unused is said to move, with its before and after', `${m.out.includes('claude default (~/.claude): unused -> Removed')} ${m.out.includes('claude default (~/.claude) moved to Removed: ')}`, 'true true');
t('#1489 migrate: login-2, unchanged, gets no before and after', m.out.includes('login-2 ('), false);
m = await sc.run('set', 'claude', 'default', 'unused');
t('#1489 AC1 the command the line names lists ~/.claude again', `${m.rc} ${sc.read().removed.some((r) => r.folder === '~/.claude')} ${/^\| `claude` \| `default` \| `~\/\.claude` \| `-` \| `unused` \|$/m.test(sc.text())}`, '0 false true');

sc = scenario(OLD, { default: 'x@a.io', 'login-2': 'y@a.io', 'login-3': 'y@a.io' });
m = await sc.run('migrate');
after = sc.read();
t('AC2 migrate: login-3 on a pinned account stays unpinned', `${pinState(after, 'login-3')} ${pinState(after, 'login-2')}`, 'unpinned/standby y@a.io/standby');
t('AC2 migrate: names the account to add', m.out.includes('add x@a.io with a in view 6'), true);

sc = scenario(OLD, { default: 'x@a.io', 'login-2': null });
m = await sc.run('migrate');
after = sc.read();
t('AC3 migrate: a signed-out login-2 is unpinned and keeps its rule', pinState(after, 'login-2'), 'unpinned/standby');
t('no pin possible: nothing to migrate, exit 0', `${m.rc} ${m.out.trim()}`, '0 nothing to migrate');
t('no pin possible: the file is byte-identical, ~/.claude stays, no .bak', `${sc.text() === OLD} ${pinState(after, 'default')} ${existsSync(`${sc.path}.bak`)}`, 'true unpinned/in rotation false');
m = await sc.run('migrate');
t('no pin possible: again changes nothing', `${m.out.trim()} ${sc.text() === OLD} ${existsSync(`${sc.path}.bak`)}`, 'nothing to migrate true false');

const THREE = ROWS(['| `claude` | `default` | `~/.claude` | `in rotation` |', '| `claude` | `login-2` | `~/.claude-logins/login-2` | `standby` |', '| `claude` | `login-3` | `~/.claude-logins/login-3` | `in rotation` |']);
sc = scenario(THREE, { default: 'x@a.io', 'login-2': 'y@a.io', 'login-3': null });
m = await sc.run('migrate');
after = sc.read();
t('mixed: the signed-in folder is pinned, the signed-out one keeps its rule unpinned', `${pinState(after, 'login-2')} ${pinState(after, 'login-3')}`, 'y@a.io/standby unpinned/in rotation');
t('mixed: ~/.claude goes to Removed and the hint names its account', `${after.removed.some((r) => r.folder === '~/.claude')} ${m.out.includes('add x@a.io with a in view 6')}`, 'true true');

const codexOnly = ROWS(['| `claude` | `default` | `~/.claude` | `standby` |', '| `codex` | `default` | `~/.codex` | `in rotation` |']);
sc = scenario(codexOnly, { default: 'x@a.io' });
process.env.HOME = sc.home;
t('a Codex-only file is left alone', needsPinMigration(parseSubscriptions(codexOnly)), false);
process.env.HOME = H;
m = await sc.run('migrate');
t('AC4 migrate: nothing to migrate, file unchanged', `${m.out.trim()} ${sc.text() === codexOnly} ${existsSync(`${sc.path}.bak`)}`, 'nothing to migrate true false');

sc = scenario(null, { default: 'x@a.io', 'login-2': 'y@a.io' });
process.env.HOME = sc.home;
t('no file is left alone', needsPinMigration(readSubscriptions(join(T, 'none.md'))), false);
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

// A check that fails on a pinned folder writes nothing
const ONEPIN = '| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n| `claude` | `login-2` | `~/.claude-logins/login-2` | `a@x.io` | `in rotation` |\n';
sc = scenario(ONEPIN, { 'login-2': 'a@x.io' });
writeFileSync(join(sc.home, '.claude-logins', 'login-2', 'status.json'), 'not json');
p = await sc.run('check');
t('AC12 the CLI check shows a non-JSON answer as not checked', p.out.split('\n').some((l) => /^claude\s+login-2\s.*\snot checked\s/.test(l)), true);
t('AC12 and leaves the pin as it was', `${sc.text() === ONEPIN} ${existsSync(`${sc.path}.bak`)}`, 'true false');

// One login on ~/.claude and no file prints what it printed before pins
sc = scenario(null, { default: 'x@a.io' });
codexIn(join(sc.home, '.codex'));
p = await sc.run('check');
t('AC20 one login on ~/.claude, no file: the check is unchanged', p.out.trimEnd().split('\n').slice(1).join('\n'), [
  '',
  'TOOL    NAME     FOLDER     STATE      ACCOUNT  PLAN  RULE',
  'claude  default  ~/.claude  signed in  x@a.io   Pro   in rotation',
  'codex   default  ~/.codex   signed in  -        -     in rotation',
  '',
  'usable: claude default, codex default',
].join('\n'));
t('AC20 and names the missing file first', /^no subscriptions file at .*: desk uses ~\/\.claude and ~\/\.codex$/.test(p.out.split('\n')[0]), true);

}

// ---- the older rules migrate to one default per tool and the rest unused
const OLD = ROWS([
  '| `claude` | `login-2` | `~/.claude-logins/login-2` | `in rotation` |',
  '| `claude` | `login-3` | `~/.claude-logins/login-3` | `in rotation` |',
  '| `claude` | `login-4` | `~/.claude-logins/login-4` | `standby` |',
  '| `codex` | `codex-2` | `~/.codex-logins/codex-2` | `standby` |',
  '| `codex` | `codex-3` | `~/.codex-logins/codex-3` | `in rotation` |',
]) + '\n## Removed\n\n| Tool | Name | Folder |\n|---|---|---|\n| `claude` | `old` | `~/.claude-logins/old` |\n';
const words = (tool) => readSubscriptions(SUBS).logins.filter((l) => l.tool === tool).map((l) => `${l.name}:${l.stored}`).join();
writeFileSync(SUBS, OLD);
c = await cli('list');
t('migrate AC1 list shows the first in rotation as default, the rest unused', ['login-2', 'login-3', 'login-4'].map((n) => c.out.split('\n').find((l) => l.startsWith(`claude  ${n}`))?.trim().split(/\s+/).at(-1)).join(), 'default,unused,unused');
t('migrate AC1 and the file now records them', words('claude'), 'login-2:default,login-3:unused,login-4:unused');
t('migrate AC2 the Codex login in rotation is its default, the one on standby unused', words('codex'), 'codex-2:unused,codex-3:default');
const dated = readdirSync(dirname(SUBS)).filter((n) => n.startsWith('subscriptions.md.bak-'));
t('migrate #1489 AC2 the previous copy is kept as a dated backup', `${dated.length} ${dated.length && readFileSync(join(dirname(SUBS), dated[0]), 'utf8') === OLD}`, '1 true');
t('migrate #1489 AC2 each changed row is shown before and after', ['login-2 (~/.claude-logins/login-2): in rotation -> default', 'login-3 (~/.claude-logins/login-3): in rotation -> unused', 'login-4 (~/.claude-logins/login-4): standby -> unused', 'codex-3 (~/.codex-logins/codex-3): in rotation -> default'].every((l) => c.out.includes(l)), true);
t('migrate #1489 AC3 an old three-column Removed table reads with no date, and is written with -', `${readSubscriptions(SUBS).removed[0].at} ${/^\| `claude` \| `old` \| `~\/\.claude-logins\/old` \| `-` \|$/m.test(readFileSync(SUBS, 'utf8'))}`, 'null true');
t('#1489 a Removed date that is not a day is named', parseSubscriptions('| Tool | Name | Folder | Removed |\n|---|---|---|---|\n| `claude` | `old` | `~/.claude-logins/old` | `soon` |\n').errors[0], 'line 3: claude old: removed "soon" wants a day as YYYY-MM-DD, or -');
const once = readFileSync(SUBS, 'utf8');
await cli('list');
t('migrate AC4 a second list leaves the file byte for byte', readFileSync(SUBS, 'utf8'), once);
const before = parseSubscriptions(OLD), after = readSubscriptions(SUBS);
t('migrate AC5 names, folders and order unchanged', after.logins.map((l) => `${l.tool}:${l.name}:${l.folder}`).join(), before.logins.map((l) => `${l.tool}:${l.name}:${l.folder}`).join());
t('migrate AC5 the Removed table unchanged', JSON.stringify(after.removed), JSON.stringify(before.removed));
writeFileSync(SUBS, ROWS(['| `claude` | `login-2` | `~/.claude-logins/login-2` | `standby` |', '| `claude` | `login-3` | `~/.claude-logins/login-3` | `off` |']));
await cli('list');
t('migrate AC3 with none in rotation the first listed is the default', words('claude'), 'login-2:default,login-3:unused');
writeFileSync(SUBS, ROWS(['| `claude` | `login-3` | `~/.claude-logins/login-3` | `off` |', '| `claude` | `login-2` | `~/.claude-logins/login-2` | `standby` |']));
await cli('list');
t('migrate a login set off is never made the default: the first not off is', words('claude'), 'login-3:unused,login-2:default');
writeFileSync(SUBS, ROWS(['| `codex` | `codex-2` | `~/.codex-logins/codex-2` | `off` |', '| `codex` | `codex-3` | `~/.codex-logins/codex-3` | `off` |']));
await cli('list');
t('migrate Codex rows that are all off stay off', readSubscriptions(SUBS).logins.filter((l) => l.tool === 'codex').map((l) => `${l.name}:${l.rule}`).join(), 'codex-2:off,codex-3:off');
refused = null;
try { setRule(parseSubscriptions(ROWS(['| `claude` | `default` | `~/.claude` | `default` |', '| `claude` | `login-2` | `~/.claude-logins/login-2` | `unused` |'])), { tool: 'claude', name: 'login-2', rule: 'off', check: () => null, repos: () => ['acme__widgets'] }); } catch (e) { refused = e.message; }
t('a login a repo\'s Subscription row runs on cannot be turned off', /acme__widgets runs on claude login-2, by its config's Subscription row/.test(refused ?? ''), true);
const workerEnv = { ...env, DESK_AUTOPILOT_WORKER: '1' };
let held;
writeFileSync(SUBS, OLD);
c = await new Promise((res) => execFile('node', [join(BIN, 'desk-env.mjs'), 'logins', 'list'], { env: workerEnv, cwd: T, encoding: 'utf8' }, (err, stdout) => res({ rc: err ? 1 : 0, out: stdout })));
t('migrate a worker is shown the migrated rules and writes nothing', `${c.rc} ${/^claude\s+login-2\s.*default$/m.test(c.out)} ${readFileSync(SUBS, 'utf8') === OLD}`, '0 true true');

// A login set off beside a default is kept off: only the older rules migrate.
writeFileSync(SUBS, ROWS(['| `claude` | `login-2` | `~/.claude-logins/login-2` | `default` |', '| `claude` | `login-3` | `~/.claude-logins/login-3` | `off` |']));
held = readFileSync(SUBS, 'utf8');
await cli('list');
t('migrate a file already saying default keeps a login set off', readFileSync(SUBS, 'utf8'), held);

// ---- changing the default
claudeIn(join(H, '.claude-logins', 'login-3'), 'ben@studia.io', 'Max 5x');
writeFileSync(SUBS, OLD);
await cli('list');
c = await cli('default', 'claude', 'login-3');
t('default AC6 login-3 is the default and login-2 unused', words('claude'), 'login-2:unused,login-3:default,login-4:unused');
t('default AC6 the output names both', c.out.trim().split('\n').at(-1), 'claude login-3: default; login-2: unused');
await cli('default', 'claude', 'login-2');
c = await cli('default', 'claude', 'BEN@studia.io');
t('default AC7 named by the account its folder is signed in to, any case', `${c.rc} ${words('claude')}`, '0 login-2:unused,login-3:default,login-4:unused');
c = await cli('default', 'codex', 'codex-2');
t('default AC8 the Codex default changes and the Claude default does not', `${c.rc} ${words('codex')} ${words('claude')}`, '0 codex-2:default,codex-3:unused login-2:unused,login-3:default,login-4:unused');
c = await cli('default', 'claude', 'nobody@example.com');
t('default an account no login is signed in to is refused', `${c.rc} ${/^logins: no claude login is signed in to nobody@example\.com/.test(c.out)}`, '1 true');
held = readFileSync(SUBS, 'utf8');
c = await cli('remove', 'claude', 'login-3');
t('default AC9 removing the default is refused', `${c.rc} ${/make another subscription the default first/.test(c.out)}`, '1 true');
t('default AC9 and the file is unchanged', readFileSync(SUBS, 'utf8'), held);
c = await new Promise((res) => execFile('node', [join(BIN, 'desk-env.mjs'), 'logins', 'default', 'claude', 'login-2'], { env: workerEnv, cwd: T, encoding: 'utf8' }, (err, stdout, stderr) => res({ rc: err ? err.code ?? 1 : 0, out: stdout + stderr })));
t('default AC10 refused to a worker as set is', `${c.rc} ${readFileSync(SUBS, 'utf8') === held}`, '4 true');
for (const rule of ['off', 'unused']) {
  c = await cli('set', 'claude', 'login-3', rule);
  t(`default set ${rule} on the default is refused, the file unchanged`, `${c.rc} ${/make another subscription the default first/.test(c.out)} ${readFileSync(SUBS, 'utf8') === held}`, '1 true true');
}
const shown = (tool) => readSubscriptions(SUBS).logins.filter((l) => l.tool === tool).map((l) => `${l.name}:${l.stored ?? l.rule}`).join();
writeFileSync(SUBS, ROWS(['| `claude` | `login-2` | `~/.claude-logins/login-2` | `default` |', '| `claude` | `login-3` | `~/.claude-logins/login-3` | `off` |', '| `claude` | `login-4` | `~/.claude-logins/login-4` | `unused` |']));
c = await cli('default', 'claude', 'login-4');
t('default a login set off stays off when the default changes', `${c.rc} ${shown('claude')}`, '0 login-2:unused,login-3:off,login-4:default');
writeFileSync(SUBS, ROWS(['| `claude` | `login-2` | `~/.claude-logins/login-2` | `in rotation` |']));
await cli('list');
t('migrate a file listing only Claude logins gains no Codex row', `${shown('claude')} ${/`codex`/.test(readFileSync(SUBS, 'utf8'))}`, 'login-2:default false');
writeFileSync(SUBS, ROWS(['| `claude` | `login-2` | `~/.claude-logins/login-2` | `default` |', '| `claude` | `login-5` | `~/elsewhere/login-5` | `unused` |']));
claudeIn(join(H, '.claude-logins', 'login-5'), 'five@example.com', 'Pro');
held = readFileSync(SUBS, 'utf8');
c = await cli('default', 'claude', 'five@example.com');
t('default an account signed in at a folder sharing a listed login\'s name is refused, the file unchanged', `${c.rc} ${/give one of them another name/.test(c.out)} ${readFileSync(SUBS, 'utf8') === held}`, '1 true true');
writeFileSync(SUBS, `${ROWS(['| `claude` | `login-2` | `~/.claude-logins/login-2` | `default` |'])}\n## Removed\n\n| Tool | Name | Folder |\n|---|---|---|\n| \`claude\` | \`login-6\` | \`~/elsewhere/login-6\` |\n`);
claudeIn(join(H, '.claude-logins', 'login-6'), 'six@example.com', 'Pro');
held = readFileSync(SUBS, 'utf8');
c = await cli('default', 'claude', 'six@example.com');
t('default an account signed in at a folder sharing a removed login\'s name is refused, the file unchanged', `${c.rc} ${/give one of them another name/.test(c.out)} ${readFileSync(SUBS, 'utf8') === held}`, '1 true true');

// AC11: a signed-in folder the file does not list is unused (login-9 was signed out for AC10 above).
claudeIn(join(H, '.claude-logins', 'login-9'), 'nine@example.com', 'Pro');
c = await cli('check');
t('default AC11 a found folder is listed as unused', `${/^claude\s+login-9\s.*unused$/m.test(c.out)} ${/standby/.test(c.out)}`, 'true false');
// AC12: no file and one Claude login: ~/.claude is the default, and nothing is written.
const empty = join(T, 'empty-config');
c = await new Promise((res) => execFile('node', [join(BIN, 'desk-env.mjs'), 'logins', 'list'], { env: { ...env, DESK_CONFIG_ROOT: empty }, cwd: T, encoding: 'utf8' }, (err, stdout) => res({ out: stdout })));
t('default AC12 no file: ~/.claude is the Claude default', /^claude\s+default\s+~\/\.claude\s+default$/m.test(c.out), true);
t('default AC12 and no file is written', existsSync(join(empty, 'subscriptions.md')), false);

console.log(fails ? `${fails} FAILED` : 'all logins checks passed');
process.exit(fails ? 1 : 0);
