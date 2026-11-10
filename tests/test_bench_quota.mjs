// suite: bench quota (the per-computer cap, the interactive reserve and unreadable readings)
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const account = { vendor: 'claude', label: 'Claude', key: 'claude:/h/.claude', name: 'Claude login default' };

// Settings: unset is 10 and 25, a number is taken, anything else refuses naming the setting and value.
t('unset settings are the defaults', JSON.stringify(Q.quotaSettings({ cap: null, reserve: null })), '{"cap":10,"reserve":25,"defaults":["bench-cap-points","bench-reserve-percent"]}');
t('set settings are read', JSON.stringify(Q.quotaSettings({ cap: '4.5', reserve: '30' })), '{"cap":4.5,"reserve":30,"defaults":[]}');
t('a cap that is not a number refuses', /`bench-cap-points` is "ten"/.test(throws(() => Q.quotaSettings({ cap: 'ten', reserve: null }))), true);
t('a zero cap refuses', /bench-cap-points/.test(throws(() => Q.quotaSettings({ cap: '0', reserve: null }))), true);
t('a reserve with a % sign refuses', /`bench-reserve-percent` is "25%"/.test(throws(() => Q.quotaSettings({ cap: null, reserve: '25%' }))), true);
t('a reserve of 100 refuses', /bench-reserve-percent/.test(throws(() => Q.quotaSettings({ cap: null, reserve: '100' }))), true);
t('the defaults are said to be the defaults', Q.settingsLine(Q.quotaSettings({ cap: null, reserve: null })), 'quota: cap 10 points of each weekly allowance, reserve 25% (the defaults: neither is set on this computer)');
const profile = join(T, 'machine.md');
writeFileSync(profile, '# Machine profile\n\n## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `bench-cap-points` | `6` | asked |\n| `bench-run-limit-deepseek` | `1` | asked |\n');
process.env.DESK_MACHINE = profile;
t('the cap is read from the machine profile', JSON.stringify(Q.quotaSettings()), '{"cap":6,"reserve":25,"defaults":["bench-reserve-percent"]}');

// Claude readings: a login's probe log as usage-probe.mjs's readLoginUsage reads it.
const { readLoginUsage, loginProbeLog } = await import('../desk/bin/usage-probe.mjs');
const fresh = now - 1000;
mkdirSync(join(T, 'usage'), { recursive: true });
const probed = (text) => { writeFileSync(loginProbeLog(join(T, 'usage')), text); return readLoginUsage({ login: null, dir: join(T, 'usage'), now }); };
const atFresh = (r) => ({ ...r, at: r.at == null ? null : fresh });
t('a reading is weekly use in percent', JSON.stringify(Q.claudeWeekly(atFresh(probed(event({ utilization: 0.43, resetsAt: reset }))), now)), JSON.stringify({ used: 43, resetsAt: reset, at: fresh }));
t('the last event stands', Q.claudeWeekly(atFresh(probed(`${event({ utilization: 0.4, resetsAt: reset })}\n${event({ utilization: 0.5, resetsAt: reset })}`)), now).used, 50);
t('no event is no reading, not zero', Q.claudeWeekly(probed('{"type":"result"}'), now).why, 'no weekly reading');
t('a plan with no weekly window says so', Q.claudeWeekly(probed(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: reset } } } })), now).why, 'its plan logs no weekly window');
t('a stale reading names its age', Q.claudeWeekly({ ...probed(event({ utilization: 0.4, resetsAt: reset })), at: now - 45 * 60000 }, now).why, 'its newest weekly reading is 45 minutes old, past the 30-minute freshness window');
t('a window past its reset is unreadable', /since reset/.test(Q.claudeWeekly(atFresh(probed(event({ utilization: 0.4, resetsAt: Math.floor(now / 1000) - 60 }))), now).why), true);

// readWeekly: a probe that prints nothing leaves the last probe's file, and that file is no reading of
// now even when it was written a moment ago (a quick run's after-probe lands within the same second).
const stubBin = join(T, 'stub-bin');
mkdirSync(stubBin, { recursive: true });
const stubClaude = (body) => { writeFileSync(join(stubBin, 'claude'), `#!/bin/sh\n${body}\n`); chmodSync(join(stubBin, 'claude'), 0o755); };
const probeEnv = { ...process.env, PATH: `${stubBin}:${process.env.PATH}` };
const claudeAccount = Q.accountFor('claude', {});
const usageAt = join(T, 'usage');
stubClaude(`echo '${event({ utilization: 0.3, resetsAt: reset })}'\necho '{"type":"result","is_error":false,"result":"ok"}'`);
t('a probe that answers is a reading', Q.readWeekly(claudeAccount, { dir: usageAt, env: probeEnv }).used, 30);
stubClaude('exit 1');
t('a silent probe right after one that answered is no new reading', /^no new weekly reading: the usage probe failed/.test(Q.readWeekly(claudeAccount, { dir: usageAt, env: probeEnv }).why ?? ''), true);
stubClaude(`echo '${event({ utilization: 0.35, resetsAt: reset })}'\necho '{"type":"result","is_error":false,"result":"ok"}'`);
t('the next probe that answers is read again', Q.readWeekly(claudeAccount, { dir: usageAt, env: probeEnv }).used, 35);

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
// readWeekly on a Codex login with no fresh log: one small Codex call writes one, then it is read.
const staleHome = join(T, 'codex-stale');
const staleDay = join(staleHome, 'sessions', '2026', '11', '07');
mkdirSync(staleDay, { recursive: true });
const rlAt = (at, used) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: {
  primary: { used_percent: 5, window_minutes: 300, resets_at: reset }, secondary: { used_percent: used, window_minutes: 10080, resets_at: reset }, plan_type: 'pro', rate_limit_reached_type: null } } });
writeFileSync(join(staleDay, 'rollout-old.jsonl'), `${rlAt(now - 45 * 60000, 40)}\n`);
const staleAccount = { vendor: 'codex', label: 'Codex', login: { dir: staleHome }, key: `codex:${staleHome}`, name: 'Codex login stale' };
let probes = 0;
const probeWrites = ({ login }) => { probes += 1; writeFileSync(join(login.dir, 'sessions', '2026', '11', '07', 'rollout-new.jsonl'), `${rlAt(Date.now(), 44)}\n`); return ''; };
t('a stale Codex reading is refreshed by a Codex call, then read', Q.readWeekly(staleAccount, { codexProbe: probeWrites }).used, 44);
t('and the call ran once', probes, 1);
t('a fresh Codex reading runs no call', `${Q.readWeekly(staleAccount, { codexProbe: probeWrites }).used} ${probes}`, '44 1');
rmSync(join(staleDay, 'rollout-new.jsonl'));
t('a Codex call that writes nothing leaves the reading stale, saying why', Q.readWeekly(staleAccount, { codexProbe: () => ': the Codex usage probe exited 1' }).why, 'its newest weekly reading is 45 minutes old, past the 30-minute freshness window: the Codex usage probe exited 1');
// The real call, against a stub codex on PATH that writes a session log in the CODEX_HOME it is given.
writeFileSync(join(stubBin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const d = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '07');
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'rollout-stub.jsonl'), ${JSON.stringify(rlAt(0, 51)).replace('1970-01-01T00:00:00.000Z', '__AT__')}.replace('__AT__', new Date().toISOString()) + '\\n');
fs.writeFileSync(a[a.indexOf('--output-last-message') + 1], 'ok');
`);
chmodSync(join(stubBin, 'codex'), 0o755);
t('codexProbeNow runs codex on the login it is given', Q.readWeekly(staleAccount, { env: probeEnv }).used, 51);
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
t('a Codex account says Codex', /^the Codex quota is unreadable/.test(Q.gate({ account: { ...account, vendor: 'codex', label: 'Codex' }, reading: { why: 'x' }, used: 0, settings })), true);

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

// OpenCode Go: no meter, so the bench's own allowance per model, from what each response reported,
// against the model's monthly limit in the plan table. The responses are an unrecorded fixture.
const { readFileSync } = await import('node:fs');
const { loadPlans } = await import('../desk/bin/bench-report.mjs');
const fx = JSON.parse(readFileSync(new URL('./fixtures/opencode-go-responses.json', import.meta.url), 'utf8'));
t('the Go fixtures say they are unrecorded', `${fx.recorded} ${/^UNRECORDED/.test(fx.source)}`, 'false true');
t('an arm on an opencode-go/ model spends OpenCode Go', Q.armVendor({ model: 'opencode-go/kimi-k3' }), Q.GO);
t('an arm on another provider/model spends that provider', Q.armVendor({ model: 'DeepSeek/v4.1-flash' }), 'deepseek');
const plansPath = join(T, 'plans.json');
writeFileSync(plansPath, JSON.stringify({ plans: [{ provider: 'OpenCode', plan: 'Go Plus', price: 40, currency: 'USD', read: '2026-11-09', url: 'https://opencode.ai/docs/console/go',
  windows: [{ name: 'monthly', hours: 720, size: 15, unit: 'usd' }], serves: [{ model: 'opencode-go/kimi-k3' }] }] }));
const plans = loadPlans(plansPath);
const kimi = { name: 'kimi', model: 'opencode-go/kimi-k3' };
const goAccount = Q.accountFor(Q.GO, {}, kimi);
const goLedger = join(T, 'usage', 'go.jsonl');
const H = 3_600_000;
const allowances = (...bodies) => ({ opencode_allowance: bodies.map(Q.responseAllowance) });
const go = (id, at, more = {}) => Q.startRun({ account: goAccount, settings, ledger: goLedger, id, fields: { task: id, arm: 'kimi' }, plans, arm: kimi, now: at, ...more });
const goEnd = (s, result, at) => Q.endRun({ account: goAccount, settings, ledger: goLedger, before: s.before, entry: s.entry, label: `${s.entry.task} (kimi)`, result, now: at });

t('AC1 the windows are 20%, 50% and 100% of the monthly limit, and say they count the bench\'s own use only', go('g1', now).line,
  "quota: OpenCode Go model opencode-go/kimi-k3: 5-hour $0.00 of $3.00 (0%), weekly $0.00 of $7.50 (0%), monthly $0.00 of $15.00 (0%); the bench's own use only: Go publishes no meter");
const g1 = Q.readLedger(goLedger).find((e) => e.id === 'g1');
const end1 = goEnd({ before: { limit: 15 }, entry: g1 }, allowances(fx.good), now + 1000);
t('AC4 a run\'s points are its dollars as a share of each window, weekly as its points', JSON.stringify(end1.quota),
  JSON.stringify({ account: 'OpenCode Go model opencode-go/kimi-k3', model: 'opencode-go/kimi-k3', allowance: 0.3, points: 4, windows: { '5-hour': 10, weekly: 4, monthly: 2 }, use: { usd: 0.3 }, own: Q.OWN_USE }));
t('AC4 on that model\'s own line in the ledger', JSON.stringify(Q.readLedger(goLedger).filter((e) => e.id === 'g1').map((e) => [e.account, e.allowance])), JSON.stringify([['opencode-go:opencode-go/kimi-k3', 0.3]]));
t('AC1 the cap applies to the 5-hour window, naming the bench\'s own use', go('g-capped', now + 2000).why,
  "the bench has used 10% of OpenCode Go model opencode-go/kimi-k3's 5-hour allowance ($0.30 of $3.00), at its 10-point cap; the bench's own use only: Go publishes no meter");
const s2 = go('g2', now + 6 * H);
t('the 5-hour window rolls past an old run while the week still counts it', `${s2.why ?? 'runs'} ${/5-hour \$0\.00 of \$3\.00 \(0%\), weekly \$0\.30 of \$7\.50 \(4%\)/.test(s2.line)}`, 'runs true');
const end2 = goEnd(s2, allowances(fx.missing), now + 6 * H + 1000);
t('AC2 a response with no allowance stops, naming provider, model and reason', end2.stop,
  'the OpenCode Go quota is unreadable for OpenCode Go model opencode-go/kimi-k3 after g2 (kimi): response 1 of 1 carries no opencode.allowance');
t('AC2 and the next run is stopped before it starts', go('g3', now + 7 * H).why,
  'the OpenCode Go quota is unreadable for OpenCode Go model opencode-go/kimi-k3: run g2 (task g2, arm kimi) has no allowance recorded: response 1 of 1 carries no opencode.allowance');
t('a run that died before its end is unknown too', Q.goUse([{ id: 'x', account: goAccount.key, at: new Date(now).toISOString(), allowance: null }], goAccount, 15, now).unknown?.id, 'x');
t('an unknown run past the month window no longer stops the model', go('g4', now + 31 * 24 * H).why, undefined);
t('AC2 an allowance in a shape the reader does not know', Q.allowanceOf(allowances(fx.unknownShape).opencode_allowance).why, 'response 1 of 1\'s opencode.allowance is {"usd":0.3}, a shape the bench cannot read');
t('AC2 a negative allowance', Q.allowanceOf([0.1, -1]).why, 'response 2 of 2\'s opencode.allowance is -1, not a finite non-negative number of dollars');
t('AC2 a run with no responses', Q.allowanceOf(undefined).why, 'the run recorded no response carrying opencode.allowance');
t('a run\'s allowance is the sum of its responses', Q.allowanceOf([0.1, 0.25, 0]).usd, 0.35);
const noRow = { name: 'other', model: `opencode-go/${fx.noPlanRow.model}` };
t('AC2 a model with no plan table row stops, naming it', Q.startRun({ account: Q.accountFor(Q.GO, {}, noRow), settings, ledger: goLedger, id: 'n1', plans, arm: noRow, now }).why,
  `the OpenCode Go quota is unreadable for OpenCode Go model opencode-go/no-such-model: no row in the plan table ${plansPath} serves it`);
t('AC2 with no plan table at all, it stops', go('n2', now, { plans: loadPlans(join(T, 'none.json')) }).why, `the OpenCode Go quota is unreadable for OpenCode Go model opencode-go/kimi-k3: there is no plan table at ${join(T, 'none.json')}`);
const use80 = { windows: [{ name: 'weekly', hours: 168, size: 7.5, used: 6, pct: 80 }], unknown: null };
t('AC1 the reserve applies to each window', Q.goGate({ account: goAccount, use: use80, settings: { cap: 90, reserve: 25 } }),
  "OpenCode Go model opencode-go/kimi-k3 has 20% of its weekly allowance left, under the 25% interactive reserve; the bench's own use only: Go publishes no meter");

// A provider with no meter and no ledger: refused, unless the machine profile gives it a run limit.
const limitLedger = join(T, 'usage', 'limit.jsonl');
const zai = Q.accountFor('zai', {});
t('AC3 a provider with no meter and no run limit is refused', Q.startRun({ account: zai, settings, ledger: limitLedger, id: 'z1', now }).why,
  'provider zai has no meter and no allowance ledger the bench can read, so its arm is refused rather than run unmetered: set a run limit with `desk-env machine set bench-run-limit-zai=<runs a week>`');
const deepseek = Q.accountFor('deepseek', {});
const d1 = Q.startRun({ account: deepseek, settings, ledger: limitLedger, id: 'd1', now });
t('AC3 with a run limit set, it runs', d1.why, undefined);
t('AC3 an unmetered run records no points', JSON.stringify(Q.endRun({ account: deepseek, settings, ledger: limitLedger, entry: d1.entry, label: 'd1', now }).quota), JSON.stringify({ account: 'provider deepseek', points: null, unmetered: true }));
t('AC3 and stops at the limit', Q.startRun({ account: deepseek, settings, ledger: limitLedger, id: 'd2', now }).why, 'the bench has started 1 run(s) on provider deepseek this week, at its 1-run limit');
const { benchSettingError } = await import('../desk/bin/machine.mjs');
t('a run limit must be a whole number of runs', benchSettingError('bench-run-limit-zai', '1.5'), '`bench-run-limit-zai` is "1.5": want a whole number of runs a week, 1 or more');
t('a run limit of a whole number is taken', benchSettingError('bench-run-limit-zai', '3'), null);

if (fails) { console.log(`FAIL ${fails} check(s) failed`); process.exit(1); }
console.log('all bench quota checks passed');
