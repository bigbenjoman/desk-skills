// suite: bench quota (the per-computer cap, the interactive reserve and unreadable readings)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

const T = mkdtempSync(join(tmpdir(), 'desk-bench-quota-'));
process.on('exit', () => rmSync(T, { recursive: true, force: true }));
for (const k of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DESK_MACHINE']) delete process.env[k];
Object.assign(process.env, { HOME: join(T, 'home'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_USAGE_DIR: join(T, 'usage'), DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md') });
const Q = await import('../desk/bin/bench-quota.mjs');
const { readCodexUsage } = await import('../desk/bin/codex-usage.mjs');

const now = Date.now();
const reset = Math.floor(now / 1000) + 3 * 24 * 3600;
const event = (sevenDay) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.02, resetsAt: reset }, seven_day: sevenDay } } });
const settings = { cap: 10, reserve: 25, defaults: [] };
const account = { vendor: 'claude', key: 'claude:/h/.claude', name: 'Claude login default' };

// Settings: unset is 10 and 25, a number is taken, anything else refuses naming the setting and value.
t('unset settings are the defaults', JSON.stringify(Q.quotaSettings({ cap: null, reserve: null })), '{"cap":10,"reserve":25,"defaults":["bench-cap-points","bench-reserve-percent"]}');
t('set settings are read', JSON.stringify(Q.quotaSettings({ cap: '4.5', reserve: '30' })), '{"cap":4.5,"reserve":30,"defaults":[]}');
t('a cap that is not a number refuses', /`bench-cap-points` is "ten"/.test(throws(() => Q.quotaSettings({ cap: 'ten', reserve: null }))), true);
t('a zero cap refuses', /bench-cap-points/.test(throws(() => Q.quotaSettings({ cap: '0', reserve: null }))), true);
t('a reserve with a % sign refuses', /`bench-reserve-percent` is "25%"/.test(throws(() => Q.quotaSettings({ cap: null, reserve: '25%' }))), true);
t('a reserve of 100 refuses', /bench-reserve-percent/.test(throws(() => Q.quotaSettings({ cap: null, reserve: '100' }))), true);
t('the defaults are said to be the defaults', Q.settingsLine(Q.quotaSettings({ cap: null, reserve: null })), 'quota: cap 10 points of each weekly allowance, reserve 25% (the defaults: neither is set on this computer)');
const profile = join(T, 'machine.md');
writeFileSync(profile, '# Machine profile\n\n## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `bench-cap-points` | `6` | asked |\n');
process.env.DESK_MACHINE = profile;
t('the cap is read from the machine profile', JSON.stringify(Q.quotaSettings()), '{"cap":6,"reserve":25,"defaults":["bench-reserve-percent"]}');

// Claude readings from rate_limit_event lines.
const fresh = now - 1000;
t('a reading is weekly use in percent', JSON.stringify(Q.claudeWeekly(event({ utilization: 0.43, resetsAt: reset }), fresh, now)), JSON.stringify({ used: 43, resetsAt: reset, at: fresh }));
t('the last event stands', Q.claudeWeekly(`${event({ utilization: 0.4, resetsAt: reset })}\n${event({ utilization: 0.5, resetsAt: reset })}`, fresh, now).used, 50);
t('no event is no reading, not zero', Q.claudeWeekly('{"type":"result"}', fresh, now).why, 'no weekly reading');
t('a malformed event cannot be parsed', Q.claudeWeekly(event({ utilization: 'lots', resetsAt: reset }), fresh, now).why, 'its weekly reading could not be parsed');
t('a stale reading names its age', Q.claudeWeekly(event({ utilization: 0.4, resetsAt: reset }), now - 45 * 60000, now).why, 'its newest weekly reading is 45 minutes old, past the 30-minute freshness window');
t('a window past its reset is unreadable', /since reset/.test(Q.claudeWeekly(event({ utilization: 0.4, resetsAt: Math.floor(now / 1000) - 60 }), fresh, now).why), true);

// Codex readings from a rollout's rate_limits block, read by codex-usage.mjs.
const codexHome = join(T, 'codex');
const day = join(codexHome, 'sessions', '2026', '11', '07');
mkdirSync(day, { recursive: true });
const rl = (seven) => JSON.stringify({ timestamp: new Date(now - 60000).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: {
  primary: { used_percent: 5, window_minutes: 300, resets_at: reset }, secondary: seven, plan_type: 'pro', rate_limit_reached_type: null } } });
writeFileSync(join(day, 'rollout-a.jsonl'), `${rl({ used_percent: 62, window_minutes: 10080, resets_at: reset })}\n`);
const codexLogin = { dir: codexHome };
t('a Codex weekly reading is its 10,080-minute window', Q.codexWeekly(readCodexUsage({ login: codexLogin, now }), now).used, 62);
writeFileSync(join(day, 'rollout-a.jsonl'), `${rl(null)}\n`);
t('a Codex plan with no weekly window is unreadable', Q.codexWeekly(readCodexUsage({ login: codexLogin, now }), now).why, 'its plan logs no weekly window');
t('no Codex logs is no reading', Q.codexWeekly(readCodexUsage({ login: { dir: join(T, 'none') }, now }), now).why, 'no weekly reading');
t('an arm on a GPT model spends Codex', Q.armVendor({ model: 'gpt-5-codex' }), 'codex');
t('an arm on an Opus model spends Claude', Q.armVendor({ model: 'opus' }), 'claude');
t('an arm with no model spends Claude', Q.armVendor({ model: null }), 'claude');

// The gate: under the cap runs, at the cap stops, under the reserve stops, unreadable stops.
const reading = (used) => ({ used, resetsAt: reset, at: fresh });
t('under the cap and over the reserve runs', Q.gate({ account, reading: reading(40), used: 9.9, settings }), null);
t('at the cap stops', Q.gate({ account, reading: reading(40), used: 10, settings }), "the bench has used 10 of its 10-point cap of Claude login default's weekly allowance this week");
t('under the reserve stops', Q.gate({ account, reading: reading(80), used: 0, settings }), 'Claude login default has 20% of its weekly allowance left, under the 25% interactive reserve');
t('at the reserve runs', Q.gate({ account, reading: reading(75), used: 0, settings }), null);
t('unreadable stops, with its reason', Q.gate({ account, reading: { why: 'no weekly reading' }, used: 0, settings }), 'the Claude quota is unreadable for Claude login default: no weekly reading');
t('a Codex account says Codex', /^the Codex quota is unreadable/.test(Q.gate({ account: { ...account, vendor: 'codex' }, reading: { why: 'x' }, used: 0, settings })), true);

// Points: the whole rise counts, a reset mid-run counts the new window, the ledger sums one window.
t('the whole rise is the run\'s points', Q.runPoints(reading(40), reading(43.5)).points, 3.5);
t('a fall counts nothing', Q.runPoints(reading(40), reading(39)).points, 0);
t('a reset during the run counts the new window\'s use', JSON.stringify(Q.runPoints(reading(90), { used: 2, resetsAt: reset + 7 * 86400, at: fresh })), JSON.stringify({ points: 2, resetsAt: reset + 7 * 86400 }));
const ledger = join(T, 'usage', 'bench-quota.jsonl');
Q.record({ id: 'r1', account: account.key, resetsAt: reset, before: 40, after: null, points: null }, ledger);
Q.record({ id: 'r1', account: account.key, resetsAt: reset, before: 40, after: 43, points: 3 }, ledger);
Q.record({ id: 'r2', account: account.key, resetsAt: reset - 7 * 86400, before: 1, after: 9, points: 8 }, ledger);
Q.record({ id: 'r3', account: 'claude:/other', resetsAt: reset, before: 1, after: 9, points: 8 }, ledger);
Q.record({ id: 'r4', account: account.key, resetsAt: reset, before: 44, after: null, points: null }, ledger);
const entries = Q.readLedger(ledger);
t('a run\'s last line stands', entries.find((e) => e.id === 'r1').points, 3);
t('only this window and account count; an unfinished run counts its rise to now', Q.benchUsed(entries, account, reading(46)), 5);
t('with no reading, the windows not yet reset count at their known points', Q.benchUsed(entries, account, { why: 'x' }, now), 3);
t('no ledger is nothing used', Q.benchUsed(Q.readLedger(join(T, 'nope.jsonl')), account, reading(10)), 0);

if (fails) { console.log(`FAIL ${fails} check(s) failed`); process.exit(1); }
console.log('all bench quota checks passed');
