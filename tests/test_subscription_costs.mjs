// suite: Costs' Claude and Codex subscription lines (fees, and use at list prices)
// layer: L2
// The Fees table in subscriptions.md and `desk-env logins fee`, the Codex price table, this month's
// use read from fixture Claude transcripts and Codex session logs, and desk-q's Costs with a use
// reading and fees, against a throwaway HOME. One check or more per acceptance criterion of GitHub
// issue 1423.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'desk', 'bin');
const T = scratch('sub-costs-');
const H = join(T, 'home');
const env = { HOME: H, DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'), DESK_LOCK_DIR: join(T, 'locks'),
  DESK_USAGE_DIR: join(T, 'usage'), DESK_COST_DIR: join(T, 'costs'), DESK_COSTS: join(T, 'costs.md'), DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'), DESK_PLATFORM: 'darwin' };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH', 'DESK_QUEUE',
  'DESK_CONFIG', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'NO_COLOR']) delete process.env[k];
Object.assign(process.env, env);
for (const d of [H, env.DESK_LOCK_DIR, env.DESK_COST_DIR]) mkdirSync(d, { recursive: true });

const L = await import(join(BIN, 'logins.mjs'));
const W = await import(join(BIN, 'worker-cost.mjs'));
const U = await import(join(BIN, 'subscription-use.mjs'));

// ---- AC1: the Fees table records a plan and a monthly fee per login
const FILE = ['| Tool | Name | Folder | Rule |', '|---|---|---|---|', '| `claude` | `work` | `~/.claude-logins/work` | `default` |', '| `codex` | `default` | `~/.codex` | `default` |', '',
  '## Fees', '', '| Tool | Name | Plan | Monthly fee (USD) |', '|---|---|---|---|', '| `claude` | `work` | `Max` | `$200` |', ''].join('\n');
const subs = L.parseSubscriptions(FILE);
const work = subs.logins.find((l) => l.name === 'work');
t('AC1 a Fees row gives its login a plan and a monthly fee', JSON.stringify(work.fee), '{"plan":"Max","usd":200}');
t('AC3 a login with no Fees row has no fee', subs.logins.find((l) => l.tool === 'codex').fee, undefined);
t('AC1 the fee survives a rewrite of the file', JSON.stringify(L.parseSubscriptions(L.renderSubscriptions(subs.logins, subs.removed)).logins.find((l) => l.name === 'work').fee), '{"plan":"Max","usd":200}');
t('AC1 a rule change keeps the fee', JSON.stringify(L.parseSubscriptions(L.setDefault(subs, { tool: 'codex', who: 'default' }).text).logins.find((l) => l.name === 'work').fee), '{"plan":"Max","usd":200}');
t('a fee for a login the file does not have is named', L.parseSubscriptions(`${FILE}| \`claude\` | \`gone\` | \`Pro\` | \`20\` |\n`).errors[0], 'line 11: a fee for claude gone, which is not one of the logins');
t('a fee that is not dollars is named', L.parseSubscriptions(FILE.replace('`$200`', '`lots`')).errors[0], 'line 10: claude work: fee "lots" is not dollars');
const set = L.parseSubscriptions(L.setFee(subs, { tool: 'codex', name: 'default', fee: '20', plan: 'Plus' }).text);
t('AC1 logins fee records a plan and fee', JSON.stringify(set.logins.find((l) => l.tool === 'codex').fee), '{"plan":"Plus","usd":20}');
t('logins fee none clears it', L.parseSubscriptions(L.setFee(subs, { tool: 'claude', name: 'work', fee: 'none' }).text).logins.find((l) => l.name === 'work').fee, undefined);
let why = null;
try { L.setFee(subs, { tool: 'claude', name: 'work', fee: '200', plan: '' }); } catch (e) { why = e.message; }
t('a fee with no plan is refused', why, 'logins: claude work: name the plan the fee is for, e.g. Max');
writeFileSync(env.DESK_SUBSCRIPTIONS, FILE);
const cli = spawnSync('node', [join(BIN, 'desk-env.mjs'), 'logins', 'fee', 'codex', 'default', '20', 'Plus'], { env: process.env, encoding: 'utf8' });
t('AC1 desk-env logins fee writes the Fees table', `${cli.status} ${cli.stdout.trim().split('\n').at(-1)} ${readFileSync(env.DESK_SUBSCRIPTIONS, 'utf8').includes('| `codex` | `default` | `Plus` | `20` |')}`, '0 codex default: Plus, $20.00 a month true');

// ---- the Codex price table, from OpenAI's published API prices
t('a Codex model is priced by its longest listed prefix', W.codexPrices('gpt-6.1-sol')?.input, 2);
t('a model the table lacks has no price', W.codexPrices('gpt-4o'), null);
t('long context doubles input and halves again output', JSON.stringify(W.CODEX_PRICES['gpt-6.1-sol'].long), '{"above":272000,"input":4,"read":0.2,"output":15}');

// ---- AC2: this month's use, by repo and by login
const NOW = Date.UTC(2026, 10, 20, 12);
const AT = (d) => new Date(Date.UTC(2026, 10, d, 9)).toISOString();
const root = join(H, 'code', 'acme'), wts = join(H, 'code', 'acme-worktrees');
const places = [{ slug: 'o__acme', dirs: [root, wts] }];
const claudeDir = join(H, '.claude-logins', 'work');
mkdirSync(join(claudeDir, 'projects', 'p'), { recursive: true });
const asst = (id, cwd, at, model, u, entrypoint = 'cli') => JSON.stringify({ type: 'assistant', requestId: id, timestamp: at, cwd, entrypoint, message: { model, usage: u } });
writeFileSync(join(claudeDir, 'projects', 'p', 's1.jsonl'), [
  asst('r1', join(wts, 'T-1'), AT(3), 'claude-opus-5-5', { input_tokens: 1000000, output_tokens: 0 }),
  asst('r1', join(wts, 'T-1'), AT(3), 'claude-opus-5-5', { input_tokens: 1000000, output_tokens: 100000 }),
  asst('r2', root, AT(4), 'claude-sonnet-5-5', { input_tokens: 1000000, output_tokens: 0 }),
  asst('r3', root, new Date(Date.UTC(2026, 9, 30)).toISOString(), 'claude-opus-5-5', { input_tokens: 1000000, output_tokens: 0 }),
  asst('r4', join(H, 'elsewhere'), AT(5), 'claude-haiku-5-5', { input_tokens: 1000000, output_tokens: 0 }),
].join('\n'));
const codexDir = join(H, '.codex');
mkdirSync(join(codexDir, 'sessions', '2026', '11', '04'), { recursive: true });
const tok = (at, input, cached, output, last) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, last_token_usage: { input_tokens: last } } } });
writeFileSync(join(codexDir, 'sessions', '2026', '11', '04', 'rollout-a.jsonl'), [
  JSON.stringify({ timestamp: AT(4), type: 'session_meta', payload: { cwd: join(wts, 'T-2') } }),
  JSON.stringify({ timestamp: AT(4), type: 'turn_context', payload: { model: 'gpt-6.1-sol', cwd: join(wts, 'T-2') } }),
  tok(AT(4), 1000000, 500000, 100000, 1000),
  tok(AT(4), 1000000, 500000, 100000, 1000),
  tok(AT(4), 1300000, 500000, 100000, 300000),
].join('\n'));
const use = U.readUse({ now: NOW, places, claudeDirs: [{ dir: claudeDir, projects: join(claudeDir, 'projects') }], codexDirs: [codexDir] });
const r2 = (n) => Math.round(n * 100) / 100;
// Claude: r1 opus $4 + $2 = $6 (counted once, at its largest output), r2 sonnet $2; r3 is October's.
t('AC2 Claude use in the repo and its worktrees, at list prices, each request once', r2(use.repos.o__acme.claude), 8);
// Codex: 500k uncached x $2 + 500k cached x $0.10 + 100k out x $10 = $2.05, then 300k past the
// 272k threshold at the long rate, $4: $1.20. The repeated event adds nothing.
t('AC2 Codex use at list prices, the long-context rate past its threshold', r2(use.repos.o__acme.codex), 3.25);
// r4: 1M Haiku input is past Haiku's 100k threshold, so at its higher rate, $0.50.
t('use outside any configured repo is kept apart', r2(use.other.claude), 0.5);
t('each login names the repos it ran', JSON.stringify(use.logins.map((l) => [l.tool, l.repos.join()])), '[["claude","o__acme"],["codex","o__acme"]]');

// ---- AC1, AC2, AC3: desk-q's Costs
const Q = await import(join(BIN, 'desk-q.mjs'));
const FIX = join(HERE, 'fixtures', 'costs-october');
copyFileSync(join(FIX, 'costs.md'), env.DESK_COSTS);
const C = await import(join(BIN, 'costs.mjs'));
const costs = C.readCosts(env.DESK_COSTS);
const cache = JSON.parse(readFileSync(join(FIX, 'cache.json'), 'utf8'));
const OCT27 = new Date(2026, 9, 27, 11, 5).getTime();
const octUse = { v: 1, at: OCT27, period: { year: 2026, month: 10 }, repos: { 'bigbenjoman__voicepa': { claude: 300, codex: 12.5 }, 'acme__solo': { claude: 40, codex: 0 } },
  logins: [{ tool: 'claude', dir: work.dir, usd: 340, repos: ['acme__solo', 'bigbenjoman__voicepa'] }, { tool: 'codex', dir: subs.logins.find((l) => l.tool === 'codex').dir, usd: 12.5, repos: ['bigbenjoman__voicepa'] }],
  other: { claude: 0, codex: 0 }, unpriced: { claude: 0, codex: 0 } };
const screen = Q.costsScreen([], { now: OCT27, costs, cache, use: octUse, subs, pinUsage: true });
const lineOf = (s, start) => s.split('\n').find((l) => l.startsWith(start)) ?? null;
t('AC2 the table has a list-price column', lineOf(screen, '  REPO')?.trimEnd(), `  ${'REPO'.padEnd(14)}${'CHARGED'.padStart(10)}${'LIST PRICE'.padStart(12)}`);
t('AC2 a repo\'s row shows its Claude and Codex use at list price', lineOf(screen, '  voicepa')?.trimEnd(), `  ${'voicepa'.padEnd(14)}${'$317.11'.padStart(10)}${'$312.50'.padStart(12)}`);
t('AC2 a repo with use and no cost sources gets a row', lineOf(screen, '  solo')?.trimEnd(), `  ${'solo'.padEnd(14)}${'–'.padStart(10)}${'$40.00'.padStart(12)}  no cost sources`);
t('AC2 it is labelled list-price equivalent, not a bill', /list-price equivalent, not a bill/.test(screen), true);
t('AC1 a login with a fee is a monthly line, shared across the repos it ran', lineOf(screen, '  claude work')?.trimEnd(), `  ${'claude work'.padEnd(14)}${'$200.00'.padStart(10)}  Max · shared by solo and voicepa`);
t('AC3 a login with no fee says so, and its use still shows', lineOf(screen, '  codex default')?.trimEnd(), `  ${'codex default'.padEnd(14)}${'–'.padStart(10)}  fee not set: /desk-setup costs · voicepa`);
const bare = Q.costsScreen([], { now: OCT27, costs: { exists: false, entries: [], budget: {}, logins: {} }, cache: null, use: octUse, subs, pinUsage: true });
t('AC2 with no cost sources, each repo\'s use still shows', lineOf(bare, '  voicepa')?.trimEnd(), `  ${'voicepa'.padEnd(14)}${'$312.50'.padStart(12)}`);
t('AC3 with no cost sources, the fee lines still show', lineOf(bare, '  codex default')?.includes('fee not set: /desk-setup costs'), true);
const none = Q.costsScreen([], { now: OCT27, costs, cache, use: null, subs: L.parseSubscriptions(''), pinUsage: true });
t('with no use reading and no fee, Costs is as it was', /LIST PRICE|SUBSCRIPTION/.test(none), false);
t('a use reading from another month is not shown', /LIST PRICE/.test(Q.costsScreen([], { now: OCT27, costs, cache, use: { ...octUse, period: { year: 2026, month: 9 } }, subs, pinUsage: true })), false);

process.exit(fails ? 1 : 0);
