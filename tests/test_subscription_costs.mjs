// suite: subscription fees and list-price use on desk-q Costs
// layer: L2
// The subscriptions file's Fees table (parsed, written, kept by the other writers, set with
// `logins fee`), the Codex list prices, the per-repo list-price reader over Claude transcripts and
// Codex rollouts, and desk-q costs with a fee recorded for one login and none for the other. A
// scratch HOME, DESK_HOME and DESK_CONFIG_ROOT on a fixed clock; nothing reads this computer's logins.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'desk', 'bin');
const FIX = join(HERE, 'fixtures', 'costs-october');
const T = scratch('desk-sub-costs-');
mkdirSync(join(T, 'bin'));
writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const HOME = join(T, 'home');
const env = { HOME, DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_LOCK_DIR: join(T, 'locks'), DESK_USAGE_DIR: join(T, 'usage'), DESK_COST_DIR: join(T, 'costs'), DESK_COSTS: join(T, 'costs.md'),
  DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills'), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'DESK_SUBSCRIPTIONS', 'DESK_SUBSCRIPTION', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COLORFGBG', 'COLORTERM', 'NO_COLOR']) delete process.env[k];
Object.assign(process.env, env);
for (const d of [env.DESK_LOCK_DIR, env.DESK_COST_DIR, join(HOME, '.claude'), join(HOME, '.codex')]) mkdirSync(d, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');

const L = await import(join(BIN, 'logins.mjs'));
const W = await import(join(BIN, 'worker-cost.mjs'));
const P = await import(join(BIN, 'list-price.mjs'));

// ---- the Fees table
const FILE = ['# Subscriptions', '', '| Tool | Name | Folder | Rule |', '|---|---|---|---|',
  `| \`claude\` | \`default\` | \`${join(HOME, '.claude')}\` | \`default\` |`, `| \`codex\` | \`default\` | \`${join(HOME, '.codex')}\` | \`default\` |`, '',
  '## Fees', '', '| Tool | Name | Plan | Monthly fee (USD) |', '|---|---|---|---|', '| `claude` | `default` | `Max 20x` | `200` |', ''].join('\n');
const subs = L.parseSubscriptions(FILE);
t('Fees: a fee row is read with its plan and dollars', JSON.stringify(subs.fees), JSON.stringify([{ tool: 'claude', name: 'default', plan: 'Max 20x', usd: 200 }]));
t('Fees: the login rows read as before, with no errors', `${subs.logins.map((l) => `${l.tool}:${l.name}:${L.ruleWord(l)}`).join(' ')} ${subs.errors.length}`, 'claude:default:default codex:default:default 0');
t('Fees: a fee row with no fee, or a fee that is not dollars, is named and left out',
  L.parseSubscriptions(FILE.replace('`200`', '`lots`')).errors.length === 1 && L.parseSubscriptions(FILE.replace('`200`', '`lots`')).fees.length === 0, true);
t('Fees: rendering writes the table back as it was read', JSON.stringify(L.parseSubscriptions(L.renderSubscriptions(subs.logins, [], subs.fees)).fees), JSON.stringify(subs.fees));
t('Fees: with no fee there is no Fees table', L.renderSubscriptions(subs.logins).includes('## Fees'), false);
t('Fees: setting a login unused keeps the fees', JSON.stringify(L.parseSubscriptions(L.setRule({ ...subs, logins: [...subs.logins, L.login({ tool: 'codex', name: 'spare', folder: join(HOME, '.codex-spare'), rule: 'standby', source: 'file', stored: 'unused' })] },
  { tool: 'codex', name: 'spare', rule: 'off', check: () => ({ usable: [] }) }).text).fees), JSON.stringify(subs.fees));
const set = L.setFee(subs, { tool: 'codex', name: 'default', plan: 'Pro', usd: '$200' });
t('setFee: adds a login\'s plan and fee beside the others', JSON.stringify(L.parseSubscriptions(set.text).fees.map((f) => `${f.tool}:${f.plan}:${f.usd}`)), JSON.stringify(['claude:Max 20x:200', 'codex:Pro:200']));
t('setFee: none clears it', L.parseSubscriptions(L.setFee(subs, { tool: 'claude', name: 'default', plan: '', usd: 'none' }).text).fees.length, 0);
const refused = (f) => { try { f(); return null; } catch (e) { return e.message; } };
t('setFee: a login desk does not know is refused, naming the logins', refused(() => L.setFee(subs, { tool: 'claude', name: 'nobody', plan: 'Max', usd: '100' })), 'logins: no claude login "nobody": the logins are default');
t('setFee: a fee that is not dollars is refused', /dollars a month/.test(refused(() => L.setFee(subs, { tool: 'claude', name: 'default', plan: 'Max', usd: 'ten' }))), true);

// ---- Codex list prices
t('codexPrice: a dated model id is priced as its model', W.codexPrice('gpt-6.1-sol-2026-09-29') === W.CODEX_PRICES['gpt-6.1-sol'], true);
t('codexPrice: gpt-6-sol is not gpt-6.1-sol', W.codexPrice('gpt-6-sol') === W.CODEX_PRICES['gpt-6-sol'], true);
t('codexPrice: a model with no list price is null', W.codexPrice('gpt-9-x'), null);
t('codexUsd: uncached input, cached reads and output', P.codexUsd('gpt-6.1-sol', { input_tokens: 2e5, cached_input_tokens: 1e5, output_tokens: 5e4 }).toFixed(4), '0.7100');
t('codexUsd: past 272K input, the long-context prices', P.codexUsd('gpt-6.1-sol', { input_tokens: 3e5, cached_input_tokens: 0, output_tokens: 0 }).toFixed(4), '1.2000');

// ---- sessions on disk: two repos, a Claude worker, a Claude interactive session and Codex rollouts
const VOICEPA = join(T, 'src', 'voicepa');
const SOLO = join(T, 'src', 'solo');
const repo = (slug, root) => {
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    `## 2. Paths\n| Field | Value |\n|---|---|\n| Primary repo root | \`${root}\` |\n\n## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`3100\` |\n`);
};
repo('bigbenjoman__voicepa', VOICEPA);
repo('acme__solo', SOLO);
const asst = (id, at, cwd, model, input, output = 0) => JSON.stringify({ type: 'assistant', requestId: id, timestamp: at, cwd, message: { model, usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output } } });
const proj = join(HOME, '.claude', 'projects', 'p');
mkdirSync(proj, { recursive: true });
// A worker in voicepa's worktrees: $4 at Opus input, logged twice, plus one request from September.
writeFileSync(join(proj, 'worker.jsonl'), [asst('r1', '2026-10-20T10:00:00Z', `${VOICEPA}-worktrees/V-1`, 'claude-opus-5-5', 1e6),
  asst('r1', '2026-10-20T10:00:00Z', `${VOICEPA}-worktrees/V-1`, 'claude-opus-5-5', 1e6), asst('r0', '2026-09-30T10:00:00Z', `${VOICEPA}-worktrees/V-1`, 'claude-opus-5-5', 1e6)].join('\n'));
// An interactive session in voicepa's root: $2 at Sonnet input. One in solo: $0.108 at Haiku, under its 100K line.
writeFileSync(join(proj, 'mine.jsonl'), asst('r2', '2026-10-21T10:00:00Z', VOICEPA, 'claude-sonnet-5-5', 1e6));
writeFileSync(join(proj, 'solo.jsonl'), asst('r3', '2026-10-21T10:00:00Z', SOLO, 'claude-haiku-5-5', 8e4, 2e5));
// One outside every repo.
writeFileSync(join(proj, 'elsewhere.jsonl'), asst('r4', '2026-10-21T10:00:00Z', join(T, 'elsewhere'), 'claude-opus-5-5', 1e6));
const tc = (at, total, last) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: last } } });
const rollouts = join(HOME, '.codex', 'sessions', '2026', '10', '22');
mkdirSync(rollouts, { recursive: true });
// voicepa's Codex: $0.71, the same event again, $1.20 past 272K, then one on a model with no price.
writeFileSync(join(rollouts, 'rollout-a.jsonl'), [JSON.stringify({ type: 'session_meta', payload: { cwd: `${VOICEPA}-worktrees/V-2` } }),
  JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
  tc('2026-10-22T10:00:00Z', 250000, { input_tokens: 2e5, cached_input_tokens: 1e5, output_tokens: 5e4 }),
  tc('2026-10-22T10:00:01Z', 250000, { input_tokens: 2e5, cached_input_tokens: 1e5, output_tokens: 5e4 }),
  tc('2026-10-22T10:01:00Z', 1900000, { input_tokens: 3e5, cached_input_tokens: 0, output_tokens: 0 }),
  JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-9-x' } }),
  tc('2026-10-22T10:02:00Z', 2000000, { input_tokens: 1e5, cached_input_tokens: 0, output_tokens: 0 })].join('\n'));

// Tuesday 27 October 2026, 11:05, as the Costs fixture's reading.
const FIXED = new Date(2026, 9, 27, 11, 5).getTime();
const use = P.useByRepo({ repos: P.repoFolders(), ...P.monthSoFar(FIXED) });
const money = (u) => (u ? `${u.usd.toFixed(2)} claude ${u.claude.toFixed(2)} codex ${u.codex.toFixed(2)} unpriced ${u.unpriced}` : 'none');
t('useByRepo: voicepa\'s worker and interactive Claude use, and its Codex use, each request once, this month only', money(use.bigbenjoman__voicepa), '7.91 claude 6.00 codex 1.91 unpriced 1');
t('useByRepo: solo\'s own', money(use.acme__solo), '0.11 claude 0.11 codex 0.00 unpriced 0');
t('useByRepo: a session outside every repo counts for none', Object.keys(use).sort().join(' '), 'acme__solo bigbenjoman__voicepa');

// ---- desk-q costs: a fee for Claude's login, none for Codex's
writeFileSync(join(env.DESK_CONFIG_ROOT, 'subscriptions.md'), FILE);
copyFileSync(join(FIX, 'costs.md'), env.DESK_COSTS);
copyFileSync(join(FIX, 'cache.json'), join(env.DESK_COST_DIR, 'cache.json'));
const Q = await import(join(BIN, 'desk-q.mjs'));
const noRead = () => ({ started: false });
const out = Q.run(['costs'], { now: FIXED, costWith: noRead }).split('\n');
const head = out.findIndex((l) => l.startsWith('  REPO'));
t('AC2 the table gains a LIST PRICE column', out[head], `  ${'REPO'.padEnd(14)}${'CHARGED'.padStart(10)}${'LIST PRICE'.padStart(13)}`);
t('AC2 voicepa\'s row gives its list-price use', out.find((l) => l.startsWith('  voicepa')), `  ${'voicepa'.padEnd(14)}${'$317.11'.padStart(10)}${'$7.91'.padStart(13)}`);
t('AC2 a row whose repo has no use reads –', out.find((l) => l.startsWith('  pr-ninja')), `  ${'pr-ninja'.padEnd(14)}${'$277.48'.padStart(10)}${'–'.padStart(13)}  ▲ credits covered $31.73`);
t('AC2 the total adds the rows\' use', out.find((l) => l.startsWith('  total')).startsWith(`  ${'total'.padEnd(14)}${'$899.97'.padStart(10)}${'$7.91'.padStart(13)}`), true);
const note = out.findIndex((l) => /list price +What this month/.test(l));
t('AC2 a note says it is a list-price equivalent, not a bill, and what it leaves out',
  note > 0 && out.slice(note, note + 4).join(' ').replace(/\s+/g, ' ').includes('It is a list-price equivalent, not a bill: the subscriptions pay for it. It leaves out 1 request on a model with no list price.'), true);
const subsAt = out.findIndex((l) => l.startsWith('  SUBSCRIPTION'));
t('AC1 a SUBSCRIPTION block under the notes', out[subsAt], `  ${'SUBSCRIPTION'.padEnd(16)}${'A MONTH'.padStart(10)}`);
t('AC1 Claude\'s fee as a monthly line, shared across the repos it runs', out[subsAt + 1], `  ${'Claude default'.padEnd(16)}${'$200.00'.padStart(10)}  Max 20x, shared by solo and voicepa`);
t('AC3 Codex\'s line says its fee is not set', out[subsAt + 2], `  ${'Codex default'.padEnd(16)}${'–'.padStart(10)}  fee not set: /desk-setup costs, shared by solo and voicepa`);
t('AC1 the total of the fees set, and how many it leaves out', out[subsAt + 3], `  ${'total'.padEnd(16)}${'$200.00'.padStart(10)} a month  leaves out 1 login with no fee`);
t('AC2 a repo with no row above still shows its list-price use', out[subsAt + 5], '  list price, repos with no row above: solo $0.11');
const js = JSON.parse(Q.run(['--json', 'costs'], { now: FIXED, costWith: noRead }));
t('--json gives each login\'s fee', JSON.stringify(js.subscriptions.map((s) => [s.tool, s.plan, s.usd, s.repos.length])), JSON.stringify([['claude', 'Max 20x', 200, 2], ['codex', null, null, 2]]));
t('--json gives each repo\'s list-price use', js.list_price.repos.bigbenjoman__voicepa.usd.toFixed(2), '7.91');

// ---- desk-env logins fee writes the file
const { execFileSync } = await import('node:child_process');
const said = execFileSync(process.execPath, [join(BIN, 'desk-env.mjs'), 'logins', 'fee', 'codex', 'default', 'Pro', '200'], { env: process.env, encoding: 'utf8' });
t('logins fee: says what it recorded', said.trim().split('\n').at(-1), 'codex default: Pro, $200.00 a month');
const after = L.parseSubscriptions(readFileSync(join(env.DESK_CONFIG_ROOT, 'subscriptions.md'), 'utf8'));
t('logins fee: the Fees table holds both, the login rows unchanged', `${after.fees.length} ${after.logins.length} ${after.errors.length}`, '2 2 0');
t('AC3 once set, the Codex line gives its fee', Q.run(['costs'], { now: FIXED, costWith: noRead }).includes('Pro, shared by solo and voicepa'), true);

console.log(fails ? `${fails} FAILED` : 'all subscription cost checks passed');
process.exit(fails ? 1 : 0);
