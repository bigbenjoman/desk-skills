// suite: repo subscription (config §3b Subscription; desk-env subscription, list and set; logins remove)
// layer: L2
// covers: desk/bin/desk-env.mjs desk/bin/logins.mjs desk-config.md
// A scratch HOME with three Claude logins, each folder's .claude.json naming its account, a
// subscriptions file and three repo configs: resolution from DESK_SUBSCRIPTION, the row and the
// default; an unknown email; one login and no file; set and its refusals; remove refused for a repo's
// login; the list; the template row. Nothing reads this computer's logins or configs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'desk', 'bin', 'desk-env.mjs');
const T = scratch('desk-repo-sub-');
const H = join(T, 'home');
const CFG = join(H, '.config', 'desk');
const SUBS = join(T, 'subscriptions.md');

// A Claude folder signed in to `email`; ~/.claude's account is in ~/.claude.json.
const account = (dir, email, json = join(dir, '.claude.json')) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(json, JSON.stringify({ oauthAccount: { emailAddress: email, planDisplayName: 'Max' } }));
};
account(join(H, '.claude'), 'ben.lavender@me.com', join(H, '.claude.json'));
account(join(H, '.claude-logins', 'login-3'), 'ben@voicepa.ai');
account(join(H, '.claude-logins', 'login-4'), 'ben@studia.io');
const SUBS_TEXT = '| Tool | Name | Folder | Rule |\n|---|---|---|---|\n'
  + '| `claude` | `default` | `~/.claude` | `default` |\n| `claude` | `login-3` | `~/.claude-logins/login-3` | `unused` |\n'
  + '| `claude` | `login-4` | `~/.claude-logins/login-4` | `unused` |\n';
writeFileSync(SUBS, SUBS_TEXT);

// A repo config whose §3b holds the Subscription row with `value`, or none for null.
const config = (slug, value) => {
  const dir = join(CFG, 'repos', slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.md');
  writeFileSync(path, ['# desk config', '', '## 0. Repo', '', '| Field | Value |', '|---|---|', `| GitHub repo | \`${slug.replace('__', '/')}\` |`, '',
    '## 3b. Cost and autonomy', '', '| Field | Recommended | Your setting |', '|---|---|---|',
    '| Usage pacing headroom (points) | `5` | `off` |',
    ...(value == null ? [] : [`| Subscription | \`default\` | \`${value}\` (a note) |`]),
    '| Check-in times | `08:00, 17:00` | `08:00` |', ''].join('\n'));
  return path;
};

const BASE = { ...process.env };
for (const k of ['DESK_SUBSCRIPTION', 'DESK_AUTOPILOT_WORKER', 'CLAUDE_CONFIG_DIR', 'DESK_CONFIG', 'DESK_REPO_DIR', 'DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_BATCH', 'DESK_STATE', 'DESK_QUEUE', 'DESK_CONFIG_TEMPLATE']) delete BASE[k];
Object.assign(BASE, { HOME: H, DESK_CONFIG_ROOT: CFG, DESK_SUBSCRIPTIONS: SUBS, DESK_MACHINE: join(T, 'no-machine.md') });
const run = (args, env = {}) => {
  const r = spawnSync('node', [BIN, ...args], { cwd: T, encoding: 'utf8', env: { ...BASE, ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
// `desk-env subscription` in a repo whose config is `path`: SUBSCRIPTION, FOLDER and SOURCE, or the exit and message.
const resolved = (path, env = {}) => {
  const r = run(['subscription'], { DESK_CONFIG: path, ...env });
  if (r.code !== 0) return `exit ${r.code}${r.out ? ` out=${r.out}` : ''}`;
  const kv = Object.fromEntries(r.out.split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^'|'$/g, '')]; }));
  return `${kv.SUBSCRIPTION} ${kv.FOLDER} ${kv.SOURCE}`;
};

const here = config('bigbenjoman__here', null);
t('AC1 no row: the Claude default, its folder, from default', resolved(here), 'ben.lavender@me.com ~/.claude default');
t('AC2 TODO row: as AC1', resolved(config('bigbenjoman__todo', 'TODO')), 'ben.lavender@me.com ~/.claude default');
const pinned = config('bigbenjoman__pinned', 'ben@studia.io');
t('AC3 the row: its account, folder, from the row', resolved(pinned), 'ben@studia.io ~/.claude-logins/login-4 row');
t('AC3 its CONFIG_DIR is the folder', run(['subscription'], { DESK_CONFIG: pinned }).out.includes(`CONFIG_DIR='${join(H, '.claude-logins', 'login-4')}'`), true);
t('AC4 DESK_SUBSCRIPTION wins over the row', resolved(pinned, { DESK_SUBSCRIPTION: 'ben@voicepa.ai' }), 'ben@voicepa.ai ~/.claude-logins/login-3 DESK_SUBSCRIPTION');
t('AC5 DESK_SUBSCRIPTION=default is the computer default', resolved(pinned, { DESK_SUBSCRIPTION: 'default' }), 'ben.lavender@me.com ~/.claude default');
t('AC6 the row matches any case', resolved(config('bigbenjoman__case', 'Ben@Studia.io')), 'ben@studia.io ~/.claude-logins/login-4 row');
const unknownPath = config('bigbenjoman__unknown', 'someone@example.com');
const unknown = run(['subscription'], { DESK_CONFIG: unknownPath });
t('AC7 an unknown email exits non-zero', unknown.code !== 0, true);
t('AC7 and prints no subscription', unknown.out, '');
t('AC7 its message names the row, the email and view 6', /§3b "Subscription" row/.test(unknown.err) && unknown.err.includes('someone@example.com') && /view 6/.test(unknown.err), true);
t('AC7 never the default', unknown.err.includes('never falls back to the default'), true);
t('AC7 an unknown DESK_SUBSCRIPTION names the variable', /DESK_SUBSCRIPTION names nobody@example.com/.test(run(['subscription'], { DESK_CONFIG: here, DESK_SUBSCRIPTION: 'nobody@example.com' }).err), true);
// AC8 with a home of its own holding one login and no file.
const ONE = join(T, 'one');
account(join(ONE, '.claude'), 'solo@example.com', join(ONE, '.claude.json'));
t('AC8 one login, no subscriptions file: its account and folder, from default', resolved(here, { HOME: ONE, DESK_SUBSCRIPTIONS: join(T, 'none.md') }), 'solo@example.com ~/.claude default');
t('--json: the same fields', JSON.stringify(JSON.parse(run(['subscription', '--json'], { DESK_CONFIG: pinned }).out)),
  JSON.stringify({ email: 'ben@studia.io', source: 'row', login: 'login-4', folder: '~/.claude-logins/login-4', configDir: join(H, '.claude-logins', 'login-4') }));

// ---- set
const row = (slug) => readFileSync(join(CFG, 'repos', slug, 'config.md'), 'utf8').split('\n').find((l) => l.startsWith('| Subscription |')) ?? null;
const forewatt = config('bigbenjoman__forewatt', null);
const set1 = run(['subscription', 'set', 'bigbenjoman__forewatt', 'ben@studia.io']);
t('AC9 set exits 0', set1.code, 0);
t('AC9 the row is added from the template', row('bigbenjoman__forewatt')?.includes('| `ben@studia.io` '), true);
t('AC9 it reads back', resolved(forewatt), 'ben@studia.io ~/.claude-logins/login-4 row');
t('AC9 the output names the previous value', set1.out, 'bigbenjoman__forewatt: Subscription ben@studia.io (was default)');
const set2 = run(['subscription', 'set', 'bigbenjoman__forewatt', 'default']);
t('AC10 back to default', row('bigbenjoman__forewatt')?.split('|')[3].trim().startsWith('`default`'), true);
t('AC10 names the email it was', set2.out, 'bigbenjoman__forewatt: Subscription default (was ben@studia.io)');
t('set keeps the note of a row it changes', (run(['subscription', 'set', 'bigbenjoman__pinned', 'BEN@voicepa.ai']), row('bigbenjoman__pinned')), '| Subscription | `default` | `ben@voicepa.ai` (a note) |');
const before = readFileSync(forewatt, 'utf8');
const bad = run(['subscription', 'set', 'bigbenjoman__forewatt', 'someone@example.com']);
t('AC11 an unknown email exits non-zero', bad.code !== 0, true);
t('AC11 the config is unchanged', readFileSync(forewatt, 'utf8'), before);
t('AC11 the message names view 6', /view 6/.test(bad.err), true);
t('set refuses a repo with no config', run(['subscription', 'set', 'bigbenjoman__nope', 'default']).code !== 0, true);
const worker = run(['subscription', 'set', 'bigbenjoman__forewatt', 'ben@studia.io'], { DESK_AUTOPILOT_WORKER: '1' });
t('AC12 a worker is refused', worker.code !== 0 && /refused in an autopilot worker/.test(worker.err), true);
t('AC12 and no config changes', readFileSync(forewatt, 'utf8'), before);

// ---- logins remove refused for a repo's login
run(['subscription', 'set', 'bigbenjoman__forewatt', 'ben@studia.io']);
const rm = run(['logins', 'remove', 'claude', 'login-4']);
t('AC13 remove exits non-zero', rm.code !== 0, true);
t('AC13 it names forewatt, and the other repo on it, as running on it', rm.err.split('\n')[0], 'logins: bigbenjoman__case, bigbenjoman__forewatt run on claude login-4, by their config\'s Subscription row: move them to another subscription first (desk-env subscription set <slug> <default|email>)');
t('AC13 the subscriptions file is unchanged', readFileSync(SUBS, 'utf8'), SUBS_TEXT);

// ---- an off subscription: no repo is pinned to it, and one a repo is pinned to is not turned off
account(join(H, '.claude-logins', 'login-5'), 'ben@personal.example');
const OFF_TEXT = `${SUBS_TEXT}| \`claude\` | \`login-5\` | \`~/.claude-logins/login-5\` | \`off\` |\n`;
writeFileSync(SUBS, OFF_TEXT);
const beforeOff = readFileSync(forewatt, 'utf8');
const offSet = run(['subscription', 'set', 'bigbenjoman__forewatt', 'ben@personal.example']);
t('a pin to an off subscription exits 4', offSet.code, 4);
t('and the config is unchanged', readFileSync(forewatt, 'utf8'), beforeOff);
t('its message says it is off and names the command that sets it unused', offSet.err,
  'desk-env subscription set: ben@personal.example is off (claude login-5), so desk starts no new work on it: set it unused first (desk-env logins set claude login-5 unused); bigbenjoman__forewatt\'s config is unchanged');
writeFileSync(`${SUBS}.bak`, 'the copy before\n');
const offPinned = run(['logins', 'set', 'claude', 'login-4', 'off']);
t('turning off a subscription repos are pinned to exits non-zero', offPinned.code !== 0, true);
t('it names both repos and the command that moves them', offPinned.err.split('\n')[0], 'logins: bigbenjoman__case, bigbenjoman__forewatt run on claude login-4, by their config\'s Subscription row: move them to another subscription first (desk-env subscription set <slug> <default|email>)');
t('the subscriptions file and its .bak are unchanged', `${readFileSync(SUBS, 'utf8') === OFF_TEXT} ${readFileSync(`${SUBS}.bak`, 'utf8')}`, 'true the copy before\n');
t('an off subscription set unused', run(['logins', 'set', 'claude', 'login-5', 'unused']).code, 0);
t('can then be pinned to', `${run(['subscription', 'set', 'bigbenjoman__forewatt', 'ben@personal.example']).code} ${resolved(forewatt)}`, '0 ben@personal.example ~/.claude-logins/login-5 row');
run(['subscription', 'set', 'bigbenjoman__forewatt', 'ben@studia.io']);
t('a subscription no repo is pinned to is turned off', `${run(['logins', 'set', 'claude', 'login-5', 'off']).code} ${readFileSync(SUBS, 'utf8').includes('| `claude` | `login-5` | `~/.claude-logins/login-5` | `off` |')}`, '0 true');
writeFileSync(SUBS, SUBS_TEXT);

// ---- list
for (const s of ['bigbenjoman__here', 'bigbenjoman__todo', 'bigbenjoman__pinned', 'bigbenjoman__case', 'bigbenjoman__unknown', 'bigbenjoman__forewatt']) config(s, null);
config('bigbenjoman__voicepa', 'ben@voicepa.ai');
config('bigbenjoman__pr-ninja', null);
config('bigbenjoman__forewatt', 'someone@example.com');
const entries = (env = {}) => JSON.parse(run(['subscription', 'list', '--json'], env).out)
  .filter((e) => ['bigbenjoman__voicepa', 'bigbenjoman__pr-ninja', 'bigbenjoman__forewatt'].includes(e.slug))
  .map((e) => `${e.slug}=${e.email}:${e.source}`).join(' ');
const want14 = 'bigbenjoman__forewatt=someone@example.com:unknown email bigbenjoman__pr-ninja=ben.lavender@me.com:default bigbenjoman__voicepa=ben@voicepa.ai:row';
t('AC14 one entry per repo: slug, email, where it came from', entries(), want14);
t('AC14 every configured repo is listed', JSON.parse(run(['subscription', 'list', '--json']).out).length, 8);
t('AC15 DESK_SUBSCRIPTION does not reach the list', entries({ DESK_SUBSCRIPTION: 'ben@studia.io' }), want14);
const rm3 = run(['logins', 'remove', 'claude', 'login-3']).err;
t('remove names only the repos on that login', /: bigbenjoman__voicepa runs on claude login-3/.test(rm3) && !rm3.includes('forewatt'), true);
// ---- issue-1642 AC3: cloud-trust, the first-run prompts a cloud start of this repo would wait on
const CK = join(T, 'code', 'widgets');
mkdirSync(CK, { recursive: true });
const onStudia = config('bigbenjoman__widgets', 'ben@studia.io');
const trustOf = (dir, projects) => { const f = join(dir, '.claude.json'); const j = JSON.parse(readFileSync(f, 'utf8')); writeFileSync(f, JSON.stringify({ ...j, projects })); };
const ct = run(['subscription', 'cloud-trust'], { DESK_CONFIG: onStudia, DESK_REPO_ROOT: CK });
t('issue-1642 AC3 an untrusted checkout prints the command that answers it, from the checkout, under its login',
  ct.out, `login-4: a cloud start would wait on the folder-trust dialog ("Is this a project you created or one you trust?"). Run this once in a terminal: cd ${CK} && CLAUDE_CONFIG_DIR=~/.claude-logins/login-4 claude, then choose "Yes, I trust this folder", and exit`);
t('issue-1642 AC3 and exits 1', ct.code, 1);
trustOf(join(H, '.claude-logins', 'login-4'), { [CK]: { hasTrustDialogAccepted: true } });
const ct2 = run(['subscription', 'cloud-trust'], { DESK_CONFIG: onStudia, DESK_REPO_ROOT: CK });
t('issue-1642 AC3 a trusted one has nothing to answer', `${ct2.code} ${ct2.out}`, `0 login-4: ${CK} is trusted, nothing to answer`);
const SUBS_FB = join(T, 'subscriptions-fallback.md');
writeFileSync(SUBS_FB, SUBS_TEXT.replace('| `login-3` | `~/.claude-logins/login-3` | `unused` |', '| `login-3` | `~/.claude-logins/login-3` | `fallback` |'));
trustOf(H, { [CK]: { hasTrustDialogAccepted: true } });
const ct3 = run(['subscription', 'cloud-trust'], { DESK_CONFIG: here, DESK_REPO_ROOT: CK, DESK_SUBSCRIPTIONS: SUBS_FB });
t('issue-1642 AC3 a repo on the default is checked under the default and its fallback', ct3.out.split('\n').map((l) => l.split(':')[0]).join(','), 'default,login-3');
t('issue-1642 AC3 the fallback not yet trusted is named with its command', ct3.out.split('\n')[1].endsWith(`cd ${CK} && CLAUDE_CONFIG_DIR=~/.claude-logins/login-3 claude, then choose "Yes, I trust this folder", and exit`) && ct3.code === 1, true);

// ---- the template
const TEMPLATE = readFileSync(join(ROOT, 'desk-config.md'), 'utf8');
const s3b = (TEMPLATE.split(/^## 3b\. /m)[1] ?? '').split(/^## /m)[0];
const tRow = s3b.split('\n').find((l) => l.startsWith('| Subscription |')) ?? '';
t('AC16 the template §3b has a Subscription row recommending default', tRow.startsWith('| Subscription | `default` | `TODO` ('), true);
t('AC16 its note says unset is default', /Unset is `default`\) \|$/.test(tRow), true);
const fresh = join(T, 'fresh.md');
writeFileSync(fresh, TEMPLATE);
t('AC16 a config set up from the template resolves to the default', resolved(fresh), 'ben.lavender@me.com ~/.claude default');

console.log(fails ? `${fails} FAIL` : 'all checks passed');
process.exit(fails ? 1 : 0);
