// suite: cache report (prompt-cache tokens and dollars per caller, from session transcripts)
// covers: desk/bin/cache-report.mjs
// cache-report.mjs on fixture transcripts in a scratch HOME with two Claude logins: one session per
// caller, a sidechain request, a request logged on two lines, a line that is not JSON, a session no
// caller claims, a caller with both TTLs, and a before and an after window.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cacheReport, callerOf, requestOf, requestUsd, rangeWindow, windowsFromArgs, windowText, compareText, worktreeDirs } from '../desk/bin/cache-report.mjs';
import { DECIDER_OPENING } from '../desk/bin/decider.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BIN = fileURLToPath(new URL('../desk/bin/', import.meta.url));

const T = mkdtempSync(join(tmpdir(), 'desk-cache-'));
const HOME = join(T, 'home');
const A = join(HOME, '.claude', 'projects', '-repo');
const B = join(HOME, '.claude-logins', 'b', 'projects', '-repo');
mkdirSync(A, { recursive: true });
mkdirSync(B, { recursive: true });
const SUBS = join(T, 'subs.md');
writeFileSync(SUBS, '| Tool | Name | Folder | Rule |\n|---|---|---|---|\n| `claude` | `a` | `~/.claude` | `in rotation` |\n| `claude` | `b` | `~/.claude-logins/b` | `in rotation` |\n');
// Two repo configs: one whose worktrees sit beside its root (`/x/repo-worktrees`), one with its own folder.
const CONFIG = join(T, 'config');
const repoConfig = (slug, rows) => {
  mkdirSync(join(CONFIG, 'repos', slug), { recursive: true });
  writeFileSync(join(CONFIG, 'repos', slug, 'config.md'), ['## 2. Paths', '| Field | Value |', '|---|---|', ...rows, ''].join('\n'));
};
repoConfig('acme__widgets', ['| Primary repo root | `/x/repo` |']);
repoConfig('acme__gadgets', ['| Primary repo root | `/y/gadgets` |', '| Worktrees directory | `/y/trees/` |']);
const WORKTREES = worktreeDirs(CONFIG);

const at = (d, h = 10) => new Date(2026, 10, d, h).toISOString();
const user = (prompt, { cwd = '/x/repo', entrypoint = 'sdk-cli' } = {}) => ({ type: 'user', cwd, entrypoint, message: { role: 'user', content: prompt } });
// One request: its usage, the TTL it asked for, and the model and day.
const req = (id, { day = 3, model = 'claude-opus-5-5', ttl = '1h', uncached = 10, w1h = 0, w5m = 0, read = 0, output = 0, side = false } = {}) => ({
  type: 'assistant', requestId: id, timestamp: at(day), isSidechain: side, promptCacheRequested: ttl,
  message: { model, usage: { input_tokens: uncached, cache_creation_input_tokens: w1h + w5m, cache_read_input_tokens: read, output_tokens: output,
    cache_creation: { ephemeral_1h_input_tokens: w1h, ephemeral_5m_input_tokens: w5m } } },
});
const session = (dir, name, lines) => writeFileSync(join(dir, `${name}.jsonl`), `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);

// In the window 1 to 14 Nov.
const r1 = req('t1', { ttl: '5m', w5m: 1000, output: 50 });
// The same request on two lines, the first with the output so far.
session(A, 'triage', [user('Triage ticket DS-1 in acme/widgets.'), { ...r1, message: { ...r1.message, usage: { ...r1.message.usage, output_tokens: 3 } } }, r1, '{not json']);
session(A, 'challenge', [user('A first triage pass put ticket DS-1 in lane C, which means'), req('t2', { w1h: 400 })]);
session(A, 'worker', [user('You are desk-ticket', { cwd: '/x/repo-worktrees/DS-1' }), req('w1', { model: 'claude-sonnet-5-5', w1h: 2000, read: 8000 }),
  req('s1', { model: 'claude-haiku-5-5', w5m: 100, side: true })]);
session(A, 'probe', [user('Reply with: ok'), req('p1', { model: 'claude-haiku-5-5', ttl: '5m', w5m: 300 })]);
session(A, 'interactive', [user('fix this', { cwd: '/x/repo-worktrees/DS-2', entrypoint: 'cli' }), req('i1', { read: 500 })]);
session(A, 'unknown', [user('hello'), req('o1', { uncached: 7 })]);
session(B, 'decider', [user(`${DECIDER_OPENING}acme__widgets. A pass has just exited`), req('d1', { ttl: '5m', w5m: 600, read: 200 })]);
// After the window, 20 Nov: the same callers on the 5-minute cache.
session(A, 'triage-later', [user('Triage ticket DS-2 in acme/widgets.'), req('t3', { day: 20, ttl: '5m', w5m: 1000 })]);
session(B, 'decider-later', [user(`${DECIDER_OPENING}acme__widgets.`), req('d2', { day: 20, ttl: '5m', w5m: 300 }), req('d3', { day: 20, ttl: '5m', w5m: 300 })]);

const WINDOW = rangeWindow('window', '2026-11-01..2026-11-14');
const DIRS = [join(HOME, '.claude', 'projects'), join(HOME, '.claude-logins', 'b', 'projects')];
const rep = cacheReport({ dirs: DIRS, windows: [WINDOW], worktrees: WORKTREES });
const row = (c, r = rep) => { const x = r.windows[0].rows[c]; return [x.sessions.size, x.requests, x.uncached, x.w1h, x.w5m, x.read]; };

// ---- attribution
t('the worktrees folders: beside the repo root, or the configured one', WORKTREES, ['/y/trees', '/x/repo-worktrees']);
t('a probe prompt is the usage probe', callerOf({ prompt: 'Reply with: ok', entrypoint: 'sdk-cli' }, WORKTREES), 'usage probe');
t('an interactive session in a worktree is interactive, not a worker', callerOf({ prompt: 'x', cwd: '/x/repo-worktrees/K', entrypoint: 'cli' }, WORKTREES), 'interactive');
t('a headless session in a worktree is a worker', callerOf({ prompt: 'x', cwd: '/x/repo-worktrees/K', entrypoint: 'sdk-cli' }, WORKTREES), 'worker');
t('so is one in a configured worktrees folder of another name', callerOf({ prompt: 'x', cwd: '/y/trees/K', entrypoint: 'sdk-cli' }, WORKTREES), 'worker');
t('a headless session in a folder no repo runs workers in is other', callerOf({ prompt: 'x', cwd: '/z/other-worktrees/K', entrypoint: 'sdk-cli' }, WORKTREES), 'other');

// ---- AC5: a row per caller, from both logins
t('AC5 triage: both passes, the 1h and 5m writes apart', row('triage'), [2, 2, 20, 400, 1000, 0]);
t('AC5 worker: its own request, not its subagent\'s', row('worker'), [1, 1, 10, 2000, 0, 8000]);
t('AC5 subagent: the sidechain request', row('subagent'), [1, 1, 10, 0, 100, 0]);
t('AC5 decider: read from the second login', row('decider'), [1, 1, 10, 0, 600, 200]);
t('AC5 usage probe', row('usage probe'), [1, 1, 10, 0, 300, 0]);
t('AC5 interactive', row('interactive'), [1, 1, 10, 0, 0, 500]);
t('AC5 a request out of the window is left out', rep.windows[0].rows.triage.requests, 2);
const cents = (u) => u && [u.write.toFixed(6), u.total.toFixed(6)];
t('AC5 opus priced at list: 10 input, 1,000 5m writes, 50 output', cents(requestUsd(requestOf(r1))), ['0.005000', '0.006040']);
t('AC5 haiku past 100,000 prompt tokens is priced at its higher rate', cents(requestUsd(requestOf(req('h', { model: 'claude-haiku-5-5', uncached: 0, read: 200000 })))), ['0.000000', '0.010000']);
t('AC5 a model with no price is counted, not priced', requestUsd(requestOf(req('x', { model: 'mystery-1' }))), null);
const text = windowText(rep);
t('AC5 the table has every caller and the columns', ['worker', 'triage', 'decider', 'usage probe', 'subagent', 'interactive', 'other'].every((c) => new RegExp(`^  ${c} `, 'm').test(text))
  && /caller\s+sessions\s+requests\s+uncached\s+write 1h\s+write 5m\s+read\s+hit ratio\s+write \$\s+\$/.test(text), true);
t('AC5 the decider\'s hit ratio is reads over all input', /^ {2}decider .* 24\.7% /m.test(text), true);

// ---- AC7: a 5m request counts as 5-minute, and a caller with both is flagged
t('AC7 a request asking for 5m with no split counts as 5m', (({ w1h, w5m }) => [w1h, w5m])(requestOf({ ...r1, message: { ...r1.message, usage: { cache_creation_input_tokens: 70 } } })), [0, 70]);
t('AC7 triage, both TTLs in one window, is flagged', /^ {2}triage .*mixed TTL$/m.test(text), true);
t('AC7 the decider, 5m only, is not', /^ {2}decider .*mixed TTL/m.test(text), false);

// ---- AC8: a bad line is skipped, an unattributed session is other, and both counts print
t('AC8 the line that is not JSON is skipped', rep.skipped, 1);
t('AC8 the unknown session is other', [rep.other, row('other')[1]], [1, 1]);
t('AC8 both counts are printed', text.includes('skipped 1 line(s) that are not JSON; 1 session(s) not attributed to a caller, counted as other'), true);

// ---- AC9: a request logged twice counts once, with its final output
t('AC9 the repeated triage request counts once', rep.windows[0].rows.triage.uncached, 20);
t('AC9 at the output of its last line, not its first', rep.windows[0].rows.triage.output, 50);

// ---- windows are whole local days, a clock-change day's 23 or 25 hours included
const autumn = rangeWindow('w', '2026-10-25..2026-10-25');
t('a one-day window ends at the next local midnight', [autumn.from, autumn.to], [new Date(2026, 9, 25).getTime(), new Date(2026, 9, 26).getTime()]);
t('--until ends at the next local midnight too', windowsFromArgs(['--since', '2026-03-29', '--until', '2026-03-29'])[0].to, new Date(2026, 2, 30).getTime());

// ---- AC6: before and after
const both = cacheReport({ dirs: DIRS, worktrees: WORKTREES, windows: windowsFromArgs(['--before', '2026-11-01..2026-11-14', '--after', '2026-11-15..2026-11-28']) });
const cmp = compareText(both);
t('AC6 the decider\'s after window: one session, two requests', [both.windows[1].rows.decider.sessions.size, both.windows[1].rows.decider.requests], [1, 2]);
t('AC6 per request: each caller has a before and an after row', /^ {2}decider\s+before\s+1\s+1 .*\n {2}\s+after\s+1\s+2 /m.test(cmp), true);
// Cache-write dollars per session. Triage: $0.0082 over two sessions before, $0.0050 over one after.
// The decider: 600 5m writes in one session in each.
const perSession = cmp.split('Per session')[1];
t('AC6 per session: triage\'s change in cache-write dollars', /^ {2}triage\s+before .*\$0\.0041 .*\n {2}\s+after .*\$0\.0050 .* \+\$0\.0009 \(\+22%\)$/m.test(perSession), true);
t('AC6 per session: the decider\'s is unchanged', /^ {2}decider\s+before .*\n {2}\s+after .* \+\$0\.0000 \(\+0%\)$/m.test(perSession), true);
t('AC6 a caller with no session in a window has no change', /^ {2}worker\s+before .*\n {2}\s+after .* -$/m.test(perSession), true);

// ---- the CLI reads every login, and refuses a malformed window
const cli = (args) => spawnSync('node', [join(BIN, 'cache-report.mjs'), ...args], { env: { ...process.env, HOME, DESK_SUBSCRIPTIONS: SUBS, CLAUDE_CONFIG_DIR: '', DESK_CONFIG_ROOT: CONFIG }, encoding: 'utf8' });
const out = cli(['--since', '2026-11-01', '--until', '2026-11-14']);
t('AC5 the CLI prints the window\'s rows, the second login\'s decider included', [out.status, /^ {2}decider\s+1\s+1 /m.test(out.stdout)], [0, true]);
t('AC5 and finds the worker by the repo configs\' worktrees folders', /^ {2}worker\s+1\s+1 /m.test(out.stdout), true);
t('a window that does not parse is a usage error', cli(['--since', 'last week']).status, 2);
t('neither --since nor --before is a usage error', cli([]).status, 2);

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
