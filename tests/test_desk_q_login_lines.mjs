// suite: desk-q login lines (the bottom lines name the Claude and Codex logins new work starts on)
// desk-q against a subscriptions file, each Claude login's probe log, each Codex login's session logs and
// a queue's benched logins, on a fixed clock, under a throwaway HOME, DESK_HOME, DESK_CONFIG_ROOT,
// DESK_LOCK_DIR and DESK_USAGE_DIR. Each line is checked in plain output and drawn at 104 columns
// under NO_COLOR. One check or more per acceptance criterion of DS-473.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-q-logins-'));
const H = join(T, 'home');
mkdirSync(join(T, 'bin'));
writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const env = { HOME: H, DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_LOCK_DIR: join(T, 'locks'), DESK_USAGE_DIR: join(T, 'usage'), DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'), DESK_PLATFORM: 'darwin',
  DESK_SKILLS_DIR: join(T, 'skills'), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'COLORFGBG', 'COLORTERM', 'NO_COLOR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) delete process.env[k];
Object.assign(process.env, env);
for (const d of [env.DESK_LOCK_DIR, env.DESK_USAGE_DIR, join(H, '.claude'), join(H, '.claude-logins', 'work'), join(H, '.claude-logins', 'spare'),
  join(H, '.codex'), join(H, '.codex-logins', 'alt')]) mkdirSync(d, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');

// Saturday 24 October 2026, 09:00 local.
const FIXED = new Date(2026, 9, 24, 9, 0).getTime();
const at = (d, h, m) => Math.round(new Date(2026, 9, d, h, m).getTime() / 1000);
const MIN = 60000;

// One repo's config and queue, with `benched` as the pass keeps it.
function repo(benched = {}, extra = {}) {
  const slug = 'acme__solo';
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `3100` |\n| Autopilot worker concurrency | `2 / 3` | `2 / 3` |\n');
  const q = join(env.DESK_HOME, 'repos', slug, 'queue.json');
  mkdirSync(dirname(q), { recursive: true });
  writeFileSync(q, JSON.stringify({ version: 1, batch: 'solo', concurrency: 2, tickets: { 'S-1': { key: 'S-1', state: 'triaged' } }, benched, ...extra }));
}

// The subscriptions file: rows as [tool, name, folder, rule].
const subscriptions = (rows) => writeFileSync(env.DESK_SUBSCRIPTIONS,
  `| Tool | Name | Folder | Rule |\n|---|---|---|---|\n${rows.map((r) => `| ${r.map((c) => `\`${c}\``).join(' | ')} |`).join('\n')}\n`);
const CLAUDE = [['claude', 'personal', '~/.claude', 'in rotation'], ['claude', 'work', '~/.claude-logins/work', 'in rotation']];

// A Claude login's probe log holding one reading, written a minute before FIXED.
function claudeReading(key, five, seven) {
  const path = join(env.DESK_USAGE_DIR, key ? `probe.${key}.log` : 'probe.log');
  writeFileSync(path, `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: five[0], resetsAt: five[1] }, seven_day: { utilization: seven[0], resetsAt: seven[1] } } } })}\n`);
  utimesSync(path, (FIXED - MIN) / 1000, (FIXED - MIN) / 1000);
}
claudeReading(null, [0.31, at(24, 14, 5)], [0.61, at(27, 6, 0)]);
claudeReading('work', [0.5, at(24, 13, 20)], [0.7, at(26, 9, 0)]);
claudeReading('spare', [0.0, at(24, 15, 0)], [0.18, at(29, 22, 0)]);

// A Codex login's session log holding one token_count event, logged ten minutes before FIXED. A window
// given as null is one the plan lacks.
function codexReading(dir, five, seven) {
  const logs = join(dir, 'sessions', '2026', '10', '24');
  rmSync(join(dir, 'sessions'), { recursive: true, force: true });
  mkdirSync(logs, { recursive: true });
  const w = (x, minutes) => (x ? { used_percent: x[0], window_minutes: minutes, resets_at: x[1] } : null);
  writeFileSync(join(logs, 'rollout-1.jsonl'), `${JSON.stringify({ timestamp: new Date(FIXED - 10 * MIN).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { primary: five ? w(five, 300) : w(seven, 10080), secondary: five ? w(seven, 10080) : null, plan_type: 'pro' } } })}\n`);
}
codexReading(join(H, '.codex'), [16, at(24, 16, 40)], [27, at(26, 9, 0)]);
codexReading(join(H, '.codex-logins', 'alt'), [40, at(24, 12, 0)], [9, at(30, 18, 0)]);

const Q = await import(join(BIN, 'desk-q.mjs'));
const { PassThrough } = await import('node:stream');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// The bottom lines in plain output: home's header from the Claude or Codex label on.
const lines = () => Q.overview(Q.loadRepos(FIXED), { now: FIXED, avail: 30 }).split('\n').filter((l) => /^(Claude|Codex) /.test(l));
// Home drawn at 104 columns under NO_COLOR: the lines between the blank line above them and the keys.
async function drawn() {
  process.env.NO_COLOR = '1';
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = { buf: '', columns: 104, rows: 40, write(s) { this.buf += s; }, on() {}, removeListener() {} };
  const ui = Q.interactive({ input, output, start: { kind: 'overview', all: false }, exit() {}, refreshMs: 600000, clock: () => FIXED, probeMs: 600000, probeWith: async () => ({ ran: true }) });
  await sleep(20);
  ui.finish(0);
  delete process.env.NO_COLOR;
  const f = output.buf.split('\x1b[H').at(-1).split('\r\n').map((l) => plain(l.replace(/\x1b\[K$/, '')));
  const keys = f.findIndex((l) => /^(move  |↑↓ )/.test(l));
  const first = f.findIndex((l) => /^Claude/.test(l));
  return { lines: f.slice(first, keys), blank: f[first - 1] === '' };
}

repo();

// ---- AC1: two Claude logins in rotation
subscriptions(CLAUDE);
const AC1 = 'Claude  personal  5h ███······· 31% 14:05 · 7d ██████···· 61% Tue 06:00  │ +1 in rotation';
t('AC1 the Claude line names the login new workers start on, its bars and resets, and +1 in rotation', lines().join('\n'), AC1);
const d1 = await drawn();
t('AC1 drawn at 104 columns under NO_COLOR: a blank line, then the same line, uncut, right above the keys', `${d1.blank} ${d1.lines.join('\n')}`, `true ${AC1}`);
const segs1 = Q.usageLines(Q.usageOf(Q.loadRepos(FIXED), FIXED), { now: FIXED, solid: true })[0].segs;
t('AC1 the label and what stands behind the login are grey, the name in the text colour',
  JSON.stringify([segs1[0], segs1[1], segs1.at(-1)]), JSON.stringify([['Claude  ', '38;5;247'], ['personal  ', null], ['  │ +1 in rotation', '38;5;247']]));

// ---- AC2: one Claude login in rotation, the other on standby
subscriptions([CLAUDE[0], ['claude', 'work', '~/.claude-logins/work', 'standby'], ['claude', 'spare', '~/.claude-logins/spare', 'off']]);
t('AC2 the line ends with the number on standby, a login turned off not counted', lines()[0].endsWith('61% Tue 06:00  │ +1 standby'), true);

// ---- AC3: a login benched at its limit while another takes spawns
subscriptions([...CLAUDE, ['claude', 'spare', '~/.claude-logins/spare', 'standby']]);
repo({ default: { login: 'personal', config_dir: null, type: 'five_hour', resets_at: at(24, 14, 5), since: FIXED - 20 * MIN, by: 'S-1' } });
const AC3 = 'Claude  work  5h █████····· 50% 13:20 · 7d ███████··· 70% Mon 09:00  │ 1 at limit to 14:05';
t('AC3 the line names the login taking spawns and ends with 1 at limit to its reset', lines()[0], AC3);
t('AC3 drawn at 104 columns', (await drawn()).lines[0], AC3);
const segs3 = Q.usageLines(Q.usageOf(Q.loadRepos(FIXED), FIXED), { now: FIXED, solid: true })[0].segs;
t('AC3 "1 at limit" is red, its reset grey', JSON.stringify(segs3.slice(-2)), JSON.stringify([['1 at limit', '38;5;210'], [' to 14:05', '38;5;247']]));
// A pass paces on its own login, desk-q's here, whichever login the line names. Plain Home lists no
// repo without a row, so the line is read over every repo, as a repo's own screen reads it.
const allLine = () => Q.usageLines(Q.usageOf(Q.loadRepos(FIXED), FIXED), { now: FIXED })[0].line;
claudeReading(null, [0.31, at(24, 14, 5)], [0.9, at(27, 6, 0)]);
t('AC3 weekly pace is judged on desk-q\'s own login: personal ahead of pace holds while the line names work',
  allLine(), `${AC3}  ▲ solo ahead of pace: no new workers until it slows`);
claudeReading(null, [0.31, at(24, 14, 5)], [0.61, at(27, 6, 0)]);
claudeReading('work', [0.5, at(24, 13, 20)], [0.9, at(26, 9, 0)]);
t('AC3 and work ahead of pace while personal is not holds nothing', ((l) => `${l.startsWith('Claude  work  ')} ${l.includes('ahead of pace')}`)(allLine()), 'true false');
claudeReading('work', [0.5, at(24, 13, 20)], [0.7, at(26, 9, 0)]);
repo({ default: { login: 'personal', config_dir: null, type: 'five_hour', resets_at: at(24, 8, 30), since: FIXED - 90 * MIN, by: 'S-1' } });
t('AC3 a bench whose reset has passed counts no more: personal takes spawns again', lines()[0].startsWith('Claude  personal  '), true);

// ---- AC4: every Claude login at its limit, standby ones too
const bench = (login, dir, resets) => ({ login, config_dir: dir, type: 'five_hour', resets_at: resets, since: FIXED - 20 * MIN, by: 'S-1' });
repo({ default: bench('personal', null, at(24, 15, 0)), work: bench('work', join(H, '.claude-logins', 'work'), at(24, 14, 5)), spare: bench('spare', join(H, '.claude-logins', 'spare'), null) },
  { usage_hold: { type: 'five_hour', resets_at: at(24, 14, 5), logins: [] } });
const AC4 = 'Claude  all 3 logins at their limit  · first back work at 14:05';
t('AC4 the line reads all 3 logins at their limit, with the first back and its time', lines()[0], AC4);
t('AC4 drawn at 104 columns', (await drawn()).lines[0], AC4);
const home4 = Q.overview(Q.loadRepos(FIXED), { now: FIXED, avail: 30 });
t('AC4 home\'s notes say no new workers start until then, and that view 6 adds a login',
  home4.split('\n').find((l) => l.includes('▲ usage'))?.replace(/^note {2}▲ usage +/, ''),
  'Every Claude login is at its limit, standby ones too, so no new workers start. The first back is work at 14:05. Add a login on view 6 to start sooner.');
t('AC4 and that note stands for the batch\'s own usage hold note', /Switch subscription/.test(home4), false);
repo();

// ---- AC5: a subscriptions file listing a Codex login
subscriptions([...CLAUDE, ['codex', 'codexmain', '~/.codex', 'in rotation'], ['codex', 'alt', '~/.codex-logins/alt', 'standby']]);
// The names take the longer one's width, codexmain's, so the bars line up.
const AC5 = 'Codex   codexmain  5h ██········ 16% 16:40 · 7d ███······· 27% Mon 09:00  │ +1 standby';
const AC5C = AC1.replace('personal  ', 'personal   ');
t('AC5 a Codex line under the Claude line names the Codex login codex calls start on, its windows and the others', lines().join('\n'), `${AC5C}\n${AC5}`);
t('AC5 drawn at 104 columns, under the Claude line', (await drawn()).lines.join('\n'), `${AC5C}\n${AC5}`);
codexReading(join(H, '.codex'), [100, at(24, 16, 40)], [27, at(26, 9, 0)]);
t('AC5 a Codex login at its limit: the line names the other, and ends with 1 at limit to its reset', lines()[1], 'Codex   alt       5h ████······ 40% 12:00 · 7d █········· 9% Fri 18:00  │ 1 at limit to 16:40');
codexReading(join(H, '.codex-logins', 'alt'), [100, at(24, 12, 0)], [9, at(30, 18, 0)]);
t('AC5 every Codex login at its limit: the line says so and names the first back', lines()[1], 'Codex   all 2 logins at their limit  · first back alt at 12:00');

// ---- AC6: a Codex plan with no 5-hour window
codexReading(join(H, '.codex'), null, [27, at(26, 9, 0)]);
codexReading(join(H, '.codex-logins', 'alt'), [40, at(24, 12, 0)], [9, at(30, 18, 0)]);
t('AC6 the Codex line shows the weekly bar alone, never a 5h bar at 0%', lines()[1], 'Codex   codexmain  7d ███······· 27% Mon 09:00  │ +1 standby');

// ---- the bottom line names a Claude login the way view 6 does: its account, not its folder
const claudeJson = (path, email) => writeFileSync(path, JSON.stringify({ oauthAccount: { emailAddress: email, planDisplayName: 'Ultra' } }));
const WORK_JSON = join(H, '.claude-logins', 'work', '.claude.json');
claudeJson(join(H, '.claude.json'), 'me@example.test');
claudeJson(WORK_JSON, 'work@example.test');
subscriptions(CLAUDE);
t('the Claude line names the account new work starts on', lines()[0].startsWith('Claude  me@example.test  5h'), true);
repo({ default: { login: 'personal', config_dir: null, type: 'seven_day', resets_at: at(27, 6, 0), since: 'x', by: 'x' },
  work: { login: 'work', config_dir: join(H, '.claude-logins', 'work'), type: 'seven_day', resets_at: at(26, 9, 0), since: 'x', by: 'x' },
  spare: { login: 'spare', config_dir: join(H, '.claude-logins', 'spare'), type: 'seven_day', resets_at: null, since: 'x', by: 'x' } });
t('with every login out, the first back is named by its account', lines()[0].includes('first back work@example.test at'), true);
t('and the note on Home says the same', Q.overview(Q.loadRepos(FIXED), { now: FIXED, avail: 30 }).includes('The first back is work@example.test at'), true);
// DS-533 AC23: with accounts pinned, each is named by its pin, whatever its folder is signed in to now.
writeFileSync(env.DESK_SUBSCRIPTIONS, '| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n'
  + '| `claude` | `work` | `~/.claude-logins/work` | `pinned@example.test` | `in rotation` |\n| `claude` | `spare` | `~/.claude-logins/spare` | `spare@example.test` | `standby` |\n');
t('DS-533 AC23 the Queue footer names the first back by its pinned email', lines()[0].includes('first back pinned@example.test at'), true);
t('DS-533 AC23 and so does Home\'s ▲ usage note', Q.overview(Q.loadRepos(FIXED), { now: FIXED, avail: 30 }).includes('The first back is pinned@example.test at'), true);
repo();
t('DS-533 AC23 the Claude line names the account new work starts on by its pin', lines()[0].startsWith('Claude  pinned@example.test  5h'), true);
subscriptions(CLAUDE);
rmSync(join(H, '.claude.json'));
rmSync(WORK_JSON);
repo();

// ---- AC7: no subscriptions file
rmSync(env.DESK_SUBSCRIPTIONS);
const AC7 = 'Claude usage  5h ███······· 31% 14:05 · 7d ██████···· 61% Tue 06:00';
t('AC7 the bottom line is exactly today\'s Claude usage line, and there is no Codex line', lines().join('\n'), AC7);
t('AC7 drawn at 104 columns too', (await drawn()).lines.join('\n'), AC7);
subscriptions([['codex', 'codexmain', '~/.codex', 'in rotation']]);
t('a file listing only a Codex login: the Claude line names the default, the unlisted folders on standby, above the Codex line',
  lines().join('\n'), 'Claude  default    5h ███······· 31% 14:05 · 7d ██████···· 61% Tue 06:00  │ +2 standby\nCodex   codexmain  7d ███······· 27% Mon 09:00  │ +1 standby');

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all desk-q login line checks passed');
process.exit(fails ? 1 : 0);
