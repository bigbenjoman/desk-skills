// suite: desk-q login lines (Home's usage lines name each tool's default, and its repo table what each repo runs on)
// layer: L1
// desk-q against a subscriptions file, each Claude login's .claude.json and probe log, each Codex login's
// session logs, each repo's Subscription row and queue, on a fixed clock, under a throwaway HOME,
// DESK_HOME, DESK_CONFIG_ROOT, DESK_LOCK_DIR and DESK_USAGE_DIR. Each line is checked in plain output,
// and drawn at 120 columns under NO_COLOR. One check or more per acceptance criterion of DS-628.
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('desk-q-logins-');
const H = join(T, 'home');
mkdirSync(join(T, 'bin'));
writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const env = { HOME: H, DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_LOCK_DIR: join(T, 'locks'), DESK_USAGE_DIR: join(T, 'usage'), DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'), DESK_PLATFORM: 'darwin',
  DESK_SKILLS_DIR: join(T, 'skills'), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH', 'DESK_BATCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'DESK_SUBSCRIPTION', 'COLORFGBG', 'COLORTERM', 'NO_COLOR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DESK_AUTOPILOT_WORKER']) delete process.env[k];
Object.assign(process.env, env);
const WORK = join(H, '.claude-logins', 'work'), SPARE = join(H, '.claude-logins', 'spare');
for (const d of [env.DESK_LOCK_DIR, env.DESK_USAGE_DIR, join(H, '.claude'), WORK, SPARE, join(H, '.codex'), join(H, '.codex-logins', 'codex-3')]) mkdirSync(d, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
// Each Claude login's account as its .claude.json records it; the default's is ~/.claude.json.
const account = (path, email, plan) => writeFileSync(path, JSON.stringify({ oauthAccount: { emailAddress: email, planDisplayName: plan } }));
account(join(H, '.claude.json'), 'ben.lavender@me.com', 'Max 20x');
account(join(WORK, '.claude.json'), 'ben@voicepa.ai', 'Max 5x');
account(join(SPARE, '.claude.json'), 'ben@studia.io', 'Pro');

// Saturday 24 October 2026, 09:00 local.
const FIXED = new Date(2026, 9, 24, 9, 0).getTime();
const at = (d, h, m) => Math.round(new Date(2026, 9, d, h, m).getTime() / 1000);
const MIN = 60000;

// A repo's config, its Subscription row naming `sub` when given.
function config(slug, sub = null) {
  const dir = join(env.DESK_CONFIG_ROOT, 'repos', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.md'),
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`3100\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`2 / 3\` |\n${sub ? `| Subscription | \`default\` | \`${sub}\` |\n` : ''}`);
}
// The repo with a queue, solo, following the default; voicepa and studia, with no batch, pinned to
// the subscriptions named (null: following the default).
function repos(voicepa = null, studia = null) {
  config('acme__solo');
  config('acme__voicepa', voicepa);
  config('acme__studia', studia);
  const q = join(env.DESK_HOME, 'repos', 'acme__solo', 'queue.json');
  mkdirSync(dirname(q), { recursive: true });
  writeFileSync(q, JSON.stringify({ version: 1, batch: 'solo', concurrency: 2, tickets: { 'S-1': { key: 'S-1', state: 'triaged' } } }));
}

// The subscriptions file: rows as [tool, name, folder, rule].
const subscriptions = (rows) => writeFileSync(env.DESK_SUBSCRIPTIONS,
  `| Tool | Name | Folder | Rule |\n|---|---|---|---|\n${rows.map((r) => `| ${r.map((c) => `\`${c}\``).join(' | ')} |`).join('\n')}\n`);
const CLAUDE = [['claude', 'personal', '~/.claude', 'default'], ['claude', 'work', '~/.claude-logins/work', 'unused'], ['claude', 'spare', '~/.claude-logins/spare', 'unused']];
const CODEX = [['codex', 'codex-2', '~/.codex', 'default'], ['codex', 'codex-3', '~/.codex-logins/codex-3', 'unused']];

// A Claude login's probe log holding one reading, written a minute before FIXED.
function claudeReading(key, five, seven) {
  const path = join(env.DESK_USAGE_DIR, key ? `probe.${key}.log` : 'probe.log');
  writeFileSync(path, `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: five[0], resetsAt: five[1] }, seven_day: { utilization: seven[0], resetsAt: seven[1] } } } })}\n`);
  utimesSync(path, (FIXED - MIN) / 1000, (FIXED - MIN) / 1000);
}
claudeReading(null, [0.31, at(24, 14, 5)], [0.61, at(27, 6, 0)]);
claudeReading('work', [0.5, at(24, 13, 20)], [0.7, at(26, 9, 0)]);
// The spare login has far more room than the default.
claudeReading('spare', [0.0, at(24, 15, 0)], [0.04, at(29, 22, 0)]);

// A Codex login's session log holding one token_count event, logged ten minutes before FIXED.
function codexReading(dir, five, seven) {
  const logs = join(dir, 'sessions', '2026', '10', '24');
  rmSync(join(dir, 'sessions'), { recursive: true, force: true });
  mkdirSync(logs, { recursive: true });
  const w = (x, minutes) => ({ used_percent: x[0], window_minutes: minutes, resets_at: x[1] });
  writeFileSync(join(logs, 'rollout-1.jsonl'), `${JSON.stringify({ timestamp: new Date(FIXED - 10 * MIN).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { primary: w(five, 300), secondary: w(seven, 10080), plan_type: 'pro' } } })}\n`);
}
codexReading(join(H, '.codex'), [16, at(24, 16, 40)], [27, at(26, 9, 0)]);
codexReading(join(H, '.codex-logins', 'codex-3'), [0, at(24, 12, 0)], [2, at(30, 18, 0)]);

const Q = await import(join(BIN, 'desk-q.mjs'));
const { PassThrough } = await import('node:stream');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Home in plain output, every configured repo listed; its usage lines; its table head.
const home = (opts = {}) => Q.overview(Q.loadRepos(FIXED), { now: FIXED, avail: 30, all: true, ...opts }).split('\n');
const lines = () => home().filter((l) => /^(Claude|Codex) /.test(l));
const head = (opts) => home(opts).find((l) => /^ {2}REPO /.test(l));
// Home drawn at 120 columns under NO_COLOR: the lines from the Claude line to the keys.
async function drawn() {
  process.env.NO_COLOR = '1';
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = { buf: '', columns: 120, rows: 40, write(s) { this.buf += s; }, on() {}, removeListener() {} };
  const ui = Q.interactive({ input, output, start: { kind: 'overview', all: false }, exit() {}, refreshMs: 600000, clock: () => FIXED, probeMs: 600000, probeWith: async () => ({ ran: true }) });
  await sleep(20);
  ui.finish(0);
  delete process.env.NO_COLOR;
  const f = output.buf.split('\x1b[H').at(-1).split('\r\n').map((l) => plain(l.replace(/\x1b\[K$/, '')));
  return f.slice(f.findIndex((l) => /^Claude/.test(l)));
}

const BARS = '5h ███······· 31% 14:05 · 7d ██████···· 61% Tue 06:00';
// The Claude and Codex lines say nothing of other logins in rotation, on standby or at their limit,
// and Home has no note to add a login.
const quiet = (h) => !h.some((l) => /^(Claude|Codex) /.test(l) && /in rotation|standby|at limit|at their limit/.test(l)) && !h.some((l) => l.includes('Add a login on view 6'));

// ---- AC1: the default and two repos pinned to other subscriptions
subscriptions(CLAUDE);
repos('ben@voicepa.ai', 'ben@studia.io');
const AC1 = `Claude  ben.lavender@me.com  ${BARS}  │ default · 2 repos pinned`;
t('AC1 the Claude line names the default, its bars, then │ default · 2 repos pinned', lines().join('\n'), AC1);
t('AC1 drawn at 120 columns under NO_COLOR, uncut', (await drawn())[0], AC1);
const segs1 = Q.usageLines(Q.usageOf(Q.loadRepos(FIXED), FIXED), { now: FIXED, solid: true })[0].segs;
t('AC1 the label and the default segment are grey, the name in the text colour',
  JSON.stringify([segs1[0], segs1[1], segs1.at(-1)]), JSON.stringify([['Claude  ', '38;5;247'], ['ben.lavender@me.com  ', null], ['  │ default · 2 repos pinned', '38;5;247']]));
t('AC9 with repos pinned: no rotation, standby or limit count, and no note to add a login', quiet(home()), true);

// ---- AC2: one repo pinned
repos('ben@voicepa.ai', null);
t('AC2 one repo pinned: │ default · 1 repo pinned', lines()[0], `Claude  ben.lavender@me.com  ${BARS}  │ default · 1 repo pinned`);
// A row naming the default's own email runs on the default, so it is not pinned elsewhere.
repos('ben@voicepa.ai', 'ben.lavender@me.com');
t('AC2 a row naming the default\'s email is not counted', lines()[0], `Claude  ben.lavender@me.com  ${BARS}  │ default · 1 repo pinned`);

// ---- AC3 and AC4: no repo pinned; ben@studia.io unused with more room than the default
repos();
const AC3 = `Claude  ben.lavender@me.com  ${BARS}  │ default`;
t('AC3 no repo pinned: │ default', lines()[0], AC3);
t('AC4 a login with more room is not named: the line names the default', lines()[0].startsWith('Claude  ben.lavender@me.com  '), true);
t('AC9 with none pinned', quiet(home()), true);

// ---- AC5: the Codex default codex-2, codex-3 unused with more room
subscriptions([...CLAUDE, ...CODEX]);
const AC5 = `Codex   ${'codex-2'.padEnd('ben.lavender@me.com'.length)}  5h ██········ 16% 16:40 · 7d ███······· 27% Mon 09:00  │ default`;
t('AC5 the Codex line names codex-2 with its bars, and no count of other logins', lines()[1], AC5);
t('AC5 drawn at 120 columns, under the Claude line', (await drawn()).slice(0, 2).join('\n'), `${AC3}\n${AC5}`);
codexReading(join(H, '.codex'), [100, at(24, 16, 40)], [27, at(26, 9, 0)]);
t('AC5 the Codex default at its limit is still the one named', lines()[1].startsWith('Codex   codex-2 '), true);
t('AC9 with the Codex default at its limit', quiet(home()), true);
codexReading(join(H, '.codex'), [16, at(24, 16, 40)], [27, at(26, 9, 0)]);

// ---- AC6: more than one Claude subscription: RUNS ON after REPO
repos('ben@voicepa.ai', 'ben@studia.io');
const h6 = home();
t('AC6 the table head has RUNS ON after REPO', /^ {2}REPO +RUNS ON +LAST PASS /.test(head()), true);
const runsOn = (name) => h6.find((l) => l.startsWith(`  ${name} `))?.slice(2).split(/ {2,}/)[1];
t('AC6 each repo\'s RUNS ON holds its subscription\'s email', ['solo', 'voicepa', 'studia'].map(runsOn).join(' '), 'ben.lavender@me.com ben@voicepa.ai ben@studia.io');
t('AC6 RUNS ON lines up under its head', h6.find((l) => l.startsWith('  solo '))?.indexOf('ben.lavender@me.com'), head().indexOf('RUNS ON'));

// ---- DS-533 AC23: with accounts pinned, the default is named by its pin, whatever its folder is signed in to now
writeFileSync(env.DESK_SUBSCRIPTIONS, '| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n'
  + '| `claude` | `work` | `~/.claude-logins/work` | `pinned@example.test` | `default` |\n| `claude` | `spare` | `~/.claude-logins/spare` | `ben@studia.io` | `unused` |\n');
t('DS-533 AC23 the Claude line names the default by its pin', lines()[0].startsWith('Claude  pinned@example.test  '), true);
subscriptions(CLAUDE);

// ---- AC7: too narrow for every column: DONE and MERGING go before RUNS ON
const widths = Array.from({ length: 140 }, (_, i) => 200 - i);
const heads = widths.map((width) => head({ width }));
// DONE the column, not ALL DONE BY.
const done = (h) => /(?<!ALL )DONE/.test(h);
t('AC7 at every width RUNS ON goes only once DONE and MERGING have gone',
  heads.every((h) => h.includes('RUNS ON') || (!done(h) && !h.includes('MERGING'))), true);
t('AC7 some width keeps RUNS ON with DONE and MERGING dropped', heads.some((h) => h.includes('RUNS ON') && !done(h) && !h.includes('MERGING')), true);
t('AC7 and some wider one keeps all three', heads.some((h) => h.includes('RUNS ON') && done(h) && h.includes('MERGING')), true);
t('AC7 and the narrowest drop RUNS ON too', heads.at(-1).includes('RUNS ON'), false);

// ---- AC8: the default at its 5-hour limit until 14:05
claudeReading(null, [1, at(24, 14, 5)], [0.61, at(27, 6, 0)]);
const h8 = home();
t('AC8 Home\'s ▲ usage note names the default, its limit and when its workers start again',
  h8.find((l) => l.includes('▲ usage'))?.replace(/^note {2}▲ usage +/, ''),
  'ben.lavender@me.com, the default, is at its 5-hour limit until 14:05. Its workers start again then.');
t('AC8 the Claude line still names the default, its 5h bar full', lines()[0].startsWith('Claude  ben.lavender@me.com  5h ██████████ 100% 14:05'), true);
t('AC9 with the default at its limit', quiet(h8), true);
claudeReading(null, [0.31, at(24, 14, 5)], [0.61, at(27, 6, 0)]);
t('AC8 no note once the default has room', home().some((l) => l.includes('▲ usage')), false);

// ---- AC10: one login and no subscriptions file
rmSync(env.DESK_SUBSCRIPTIONS);
rmSync(WORK, { recursive: true, force: true });
rmSync(SPARE, { recursive: true, force: true });
repos();
t('AC10 the bottom line is the Claude usage line, and there is no Codex line', lines().join('\n'), 'Claude usage  5h ███······· 31% 14:05 · 7d ██████···· 61% Tue 06:00');
t('AC10 the table has no RUNS ON', head().includes('RUNS ON'), false);
t('AC10 drawn at 120 columns too', (await drawn())[0], 'Claude usage  5h ███······· 31% 14:05 · 7d ██████···· 61% Tue 06:00');

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all desk-q login line checks passed');
process.exit(fails ? 1 : 0);
