// suite: codex usage (each Codex login's windows and plan, read from its own session logs)
// Rollout logs under a scratch HOME, in the shape Codex writes them: a token_count event's rate_limits
// with a primary and a secondary window, plan_type and rate_limit_reached_type. Two CODEX_HOME folders,
// ~/.codex and ~/.codex-logins/b, plus one with no logs. Nothing reads this computer's Codex folders.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-codex-usage-'));
const H = join(T, 'home');
mkdirSync(H, { recursive: true });
for (const k of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_CONFIG', 'DESK_QUEUE', 'DESK_AUTOPILOT_STATE']) delete process.env[k];
Object.assign(process.env, { HOME: H, DESK_CONFIG_ROOT: join(H, '.config', 'desk'), DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'),
  DESK_USAGE_DIR: join(T, 'usage'), DESK_LOCK_DIR: join(T, 'locks') });
mkdirSync(process.env.DESK_LOCK_DIR);

const C = await import(join(BIN, 'codex-usage.mjs'));
const P = await import(join(BIN, 'usage-probe.mjs'));

const now = Date.now();
const inHours = (h) => Math.floor((now + h * 3600 * 1000) / 1000);
const iso = (hAgo) => new Date(now - hAgo * 3600 * 1000).toISOString();
const win = (used, minutes, resetH) => ({ used_percent: used, window_minutes: minutes, resets_at: inHours(resetH) });
// One session's log: its meta, a turn, then a token_count event per reading, newest last.
const rollout = (readings) => [
  JSON.stringify({ timestamp: iso(2), type: 'session_meta', payload: { id: 'S', cwd: '/w', cli_version: '0.167.0' } }),
  JSON.stringify({ timestamp: iso(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rate_limits in a prompt is not a reading' }] } }),
  ...readings.map(({ primary, secondary = null, plan, reached = null, hAgo = 1 }) => JSON.stringify({ timestamp: iso(hAgo), type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1200, output_tokens: 80, total_tokens: 1280 } },
      rate_limits: { primary, secondary, credits: { has_credits: false, unlimited: false, balance: null }, plan_type: plan, rate_limit_reached_type: reached } } })),
].join('\n') + '\n';
// A log written `minsAgo` minutes ago, under its day's folder; `zst` keeps it compressed.
const log = (home, name, text, minsAgo, { zst = false } = {}) => {
  const dir = join(home, 'sessions', '2026', '11', '06');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `rollout-2026-11-06T${name}.jsonl${zst ? '.zst' : ''}`);
  writeFileSync(p, zst ? zstdCompressSync(Buffer.from(text)) : text);
  const at = (now - minsAgo * 60 * 1000) / 1000;
  utimesSync(p, at, at);
  return p;
};
// A rewritten log is newer each time, as a log Codex appends to is, and stays older than the .zst below.
let stamps = 0;
const stamp = (p) => { const at = (now - 600000 + ++stamps * 1000) / 1000; utimesSync(p, at, at); };
const A = join(H, '.codex');
const B = join(H, '.codex-logins', 'b');
const login = (dir) => C.codexLogins().find((l) => l.dir === dir);
const read = (dir) => C.readCodexUsage({ login: login(dir), now });

// ---- AC1, AC2, AC9: a pro plan with both windows; the newest log's last reading.
log(A, '08-00-00-old', rollout([{ primary: win(90, 300, 1), secondary: win(80, 10080, 50), plan: 'plus' }]), 120);
const newest = log(A, '10-00-00-new', rollout([
  { primary: win(5, 300, 4), secondary: win(20, 10080, 70), plan: 'pro', hAgo: 0.5 },
  { primary: win(16, 300, 4), secondary: win(27, 10080, 70), plan: 'pro', hAgo: 0.2 },
]), 10);
const a = read(A);
t('AC1 the weekly use is the newest log\'s last reading', a.seven_day?.used, 27);
t('AC1 and its reset time', a.seven_day?.resetsAt, inHours(70));
t('AC1 the reading\'s time is its event\'s', a.at, Date.parse(iso(0.2)));
t('AC2 the 300-minute window is the 5-hour one', `${a.five_hour?.used} ${a.five_hour?.resetsAt === inHours(4)}`, '16 true');
t('AC2 with no window missing', a.none.join(), '');
t('AC9 the plan is the one the newest reading names', a.plan, 'pro');
writeFileSync(newest, rollout([{ primary: win(30, 10080, 70), secondary: win(12, 300, 3), plan: 'pro' }]));
stamp(newest);
const swapped = read(A);
t('AC2 a 300-minute window in the secondary slot is still the 5-hour one', `${swapped.five_hour?.used} ${swapped.seven_day?.used}`, '12 30');

// ---- AC3: a prolite plan with only the weekly window.
writeFileSync(newest, rollout([{ primary: win(9, 10080, 90), secondary: null, plan: 'prolite' }]));
stamp(newest);
const lite = read(A);
t('AC3 a plan with only a 10,080-minute window has no 5-hour window', lite.none.join(), 'five_hour');
t('AC3 never 0%, never a reading', lite.five_hour, null);
t('AC3 and its weekly window reads', lite.seven_day?.used, 9);
t('AC9 the prolite plan is named as logged', lite.plan, 'prolite');

// ---- AC4: at a limit, by 100% used or by the limit-reached type.
writeFileSync(newest, rollout([{ primary: win(100, 10080, 30), plan: 'prolite' }]));
stamp(newest);
const full = read(A);
t('AC4 a window at 100% is at its limit', full.seven_day?.limited, true);
t('AC4 until its reset time', `${full.limit?.window} ${full.limit?.resetsAt === inHours(30)}`, 'seven_day true');
writeFileSync(newest, rollout([{ primary: win(97, 300, 2), secondary: win(40, 10080, 30), plan: 'pro', reached: 'primary' }]));
stamp(newest);
const reached = read(A);
t('AC4 a limit-reached type naming a slot puts that window at its limit', `${reached.five_hour?.limited} ${reached.seven_day?.limited}`, 'true false');
t('AC4 the login is at the 5-hour limit until it resets', `${reached.limit?.window} ${reached.limit?.resetsAt === inHours(2)}`, 'five_hour true');
writeFileSync(newest, rollout([{ primary: win(60, 300, 2), secondary: win(99, 10080, 30), plan: 'pro', reached: 'rate_limit_reached' }]));
stamp(newest);
t('AC4 a type naming no slot is the fullest window\'s', read(A).limit?.window, 'seven_day');
writeFileSync(newest, rollout([{ primary: win(16, 300, 4), secondary: win(27, 10080, 70), plan: 'pro' }]));
stamp(newest);
t('AC4 a reading under its limits is at none', read(A).limit, null);

// ---- AC5: a window past its reset is no reading, never its old figure.
writeFileSync(newest, rollout([{ primary: win(100, 300, -1), secondary: win(55, 10080, -2), plan: 'pro' }]));
stamp(newest);
const past = read(A);
t('AC5 a reset that has passed reads as no reading', `${past.five_hour} ${past.seven_day}`, 'null null');
t('AC5 and not as a window the plan lacks', past.none.join(), '');
t('AC5 and a limit past its reset holds nothing', past.limit, null);

// ---- AC6: the newest log is compressed.
writeFileSync(newest, rollout([{ primary: win(16, 300, 4), secondary: win(27, 10080, 70), plan: 'pro' }]));
stamp(newest);
const zst = log(A, '11-00-00-zst', rollout([{ primary: win(44, 300, 3), secondary: win(33, 10080, 70), plan: 'pro' }]), 1, { zst: true });
const z = read(A);
t('AC6 a compressed newest log is read', `${z.five_hour?.used} ${z.seven_day?.used}`, '44 33');

// ---- AC7: login B reads only its own folder's logs, though login A's are newer.
log(B, '09-00-00-b', rollout([{ primary: win(9, 10080, 100), plan: 'prolite' }]), 60);
const b = read(B);
t('AC7 login B is found under ~/.codex-logins', login(B)?.name, 'b');
t('AC7 login B\'s reading is its own', `${b.seven_day?.used} ${b.plan} ${b.none.join()}`, '9 prolite five_hour');
t('AC7 and login A\'s is unchanged by it', read(A).seven_day?.used, 33);

// ---- AC8: a login with no session logs.
const N = join(H, '.codex-logins', 'n');
mkdirSync(N, { recursive: true });
const n = read(N);
t('AC8 a login with no session logs has no reading', `${n.at} ${n.five_hour} ${n.seven_day} ${n.plan}`, 'null null null null');
t('AC8 and lacks no window', n.none.join(), '');

// ---- AC10: the printed readings.
rmSync(zst);
const printed = spawnSync('node', [join(BIN, 'usage-probe.mjs'), 'readings'], { encoding: 'utf8' });
const lines = printed.stdout.split('\n');
const codexAt = lines.indexOf('Codex');
t('AC10 the readings have a Claude section, then a Codex one', `${lines[0]} ${codexAt > 1 && lines[codexAt - 1] === ''}`, 'Claude true');
const row = (name) => lines.slice(codexAt + 1).find((l) => l.startsWith(`${name} `)) ?? '';
t('AC10 login A by name with its plan, 5-hour and weekly use and resets',
  /^default {2}pro · 5h 16%, resets \S+ \S+ UTC · 7d 27%, resets \S+ \S+ UTC · read \S+ \S+ UTC$/.test(row('default')), true);
t('AC10 login B with its plan, no 5-hour window, and its weekly use and reset',
  /^b {8}prolite · no 5-hour window · 7d 9%, resets \S+ \S+ UTC · read \S+ \S+ UTC$/.test(row('b')), true);
t('AC10 a login with no logs says so', /^n +no reading$/.test(row('n')), true);
const lp = C.codexUsageByLogin({ now });
const at = (r, pct) => P.codexReadingsText([{ ...r, reading: { ...r.reading, seven_day: { used: pct, resetsAt: inHours(30), limited: pct >= 100 } } }], now);
t('AC10 a window at its limit is printed so', at(lp[0], 100).includes('7d at its limit until '), true);
t('AC10 a reset passed by print time is printed as no reading',
  P.codexReadingsText([{ ...lp[0], reading: { ...lp[0].reading, five_hour: { used: 50, resetsAt: inHours(-0.1), limited: false } } }], now).includes('5h no reading'), true);

// No Codex folder at all: the readings are the Claude lines alone, as they always were.
rmSync(join(H, '.codex'), { recursive: true });
rmSync(join(H, '.codex-logins'), { recursive: true });
t('no Codex login: no Codex section', P.allReadingsText([{ login: { name: 'default' }, reading: { at: null, none: [] } }], C.codexUsageByLogin({ now }), now), 'default  no reading');

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
