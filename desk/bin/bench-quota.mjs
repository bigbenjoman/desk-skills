// The bench's quota guard: before each run it reads the weekly allowance of the account the run will
// spend, and stops the bench at the per-computer cap of points the bench may use in one weekly window,
// at the interactive reserve, or on any reading it cannot trust. After each run it reads again, and the
// whole rise in that account's weekly use during the run counts as that run's quota points, other work
// on the account included: the conservative reading when workers share it.
//
// The cap and reserve are per computer, because one allowance covers every repo on it: the machine
// profile's Sizing rows `bench-cap-points` and `bench-reserve-percent` (desk-env.mjs owns the file;
// /desk-setup asks for them). Unset, they are DEFAULT_CAP points and a DEFAULT_RESERVE% reserve.
//
// A Claude account's reading is taken by a usage probe on its login just before it is read
// (usage-probe.mjs), so it is seconds old; a Codex account's comes from its own session logs
// (codex-usage.mjs), and when those hold none fresh, one small Codex call on that login writes one.
// Either is refused when older than FRESH_MS. The points each run used are kept per
// computer in <usage dir>/bench-quota.jsonl, one line per run, written before the run starts (its
// `after` and `points` null) and again once it ends; the last line for a run's id stands.
//
// OpenCode Go has no meter: the guard keeps the bench's own allowance ledger per model instead (below).
// Any other provider with neither is refused unless the machine profile gives it a run limit.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineValue } from './desk-env.mjs';
import { BENCH_CAP_KEY, BENCH_RESERVE_KEY, benchSettingError as settingError } from './machine.mjs';
import { loginProbeLog, probeNow, readLoginUsage, usageDir } from './usage-probe.mjs';
import { loginOf } from './claude-logins.mjs';
import { defaultLogin, login as makeLogin } from './logins.mjs';
import { readCodexUsage } from './codex-usage.mjs';
import { planFor } from './bench-report.mjs';

export const DEFAULT_CAP = 10;
export const DEFAULT_RESERVE = 25;
export const CAP_KEY = BENCH_CAP_KEY;
export const RESERVE_KEY = BENCH_RESERVE_KEY;
// A reading older than this says too little about the allowance now.
export const FRESH_MS = 30 * 60 * 1000;
// Two readings whose weekly resets are this close are the same window.
const SAME_WINDOW_S = 60 * 60;
const round1 = (x) => Math.round(x * 10) / 10;

// The cap and reserve, each from the machine profile or its default. A value that is not a number (or
// a reserve of 100% or more) throws, naming the setting and the value: never run uncapped.
//   -> { cap, reserve, defaults: [key] }
export function quotaSettings({ cap = machineValue(CAP_KEY), reserve = machineValue(RESERVE_KEY) } = {}) {
  const defaults = [];
  const read = (key, raw, def) => {
    if (raw == null || String(raw).trim() === '') { defaults.push(key); return def; }
    const bad = settingError(key, raw);
    if (bad) throw new Error(`refusing to start: the machine profile's ${bad}`);
    return Number(String(raw).trim());
  };
  return { cap: read(CAP_KEY, cap, DEFAULT_CAP), reserve: read(RESERVE_KEY, reserve, DEFAULT_RESERVE), defaults };
}

export function settingsLine(s) {
  const note = s.defaults.length === 2 ? ' (the defaults: neither is set on this computer)'
    : s.defaults.length ? ` (\`${s.defaults[0]}\` unset, so its default)` : '';
  return `quota: cap ${s.cap} points of each weekly allowance, reserve ${s.reserve}%${note}`;
}

// Which vendor's allowance an arm spends: the provider a `<provider>/<model>` id names (GO for OpenCode
// Go), Codex for a GPT or Codex model, Claude otherwise.
export const GO = 'opencode-go';
export function armVendor(arm) {
  const model = arm?.model ?? '';
  const slash = model.indexOf('/');
  if (slash > 0) return model.slice(0, slash).toLowerCase();
  return /^(gpt-|codex)/i.test(model) ? 'codex' : 'claude';
}
// Claude and Codex publish a meter the guard reads; GO has the bench's own allowance ledger instead.
export const metered = (vendor) => vendor === 'claude' || vendor === 'codex';

// The account a run spends: the Claude login its environment points at, the signed-in Codex login, one
// OpenCode Go model's allowance (Go limits each model on its own), or another provider as a whole.
//   -> { vendor, label, login, key, name } (an OpenCode Go account: { vendor, label, model, key, name })
export function accountFor(vendor, env = process.env, arm = null) {
  if (vendor === GO) return { vendor, label: 'OpenCode Go', model: arm?.model ?? null, key: `${GO}:${arm?.model}`, name: `OpenCode Go model ${arm?.model}` };
  if (!metered(vendor)) return { vendor, label: vendor, key: vendor, name: `provider ${vendor}` };
  const l = vendor === 'codex'
    ? (env.CODEX_HOME ? makeLogin({ tool: 'codex', name: basename(resolve(env.CODEX_HOME)), folder: env.CODEX_HOME, rule: null, source: 'env' }) : defaultLogin('codex'))
    : loginOf(env.CLAUDE_CONFIG_DIR || null);
  const label = vendor === 'codex' ? 'Codex' : 'Claude';
  return { vendor, label, login: l, key: `${vendor}:${l.dir}`, name: `${label} login ${l.name}` };
}

// The stop for a reading that cannot be trusted, before a run or (`when`) after one.
export const unreadable = (account, why, when = '') => `the ${account.label} quota is unreadable for ${account.name}${when}: ${why}`;

const staleWhy = (age) => `its newest weekly reading is ${Math.round(age / 60000)} minutes old, past the ${FRESH_MS / 60000}-minute freshness window`;

// A reading's weekly window as { used (percent), resetsAt (s), at (ms) }, or { why } naming what makes it
// unreadable. A missing reading is never zero.
export function weekly({ used, resetsAt, at, why }, now = Date.now()) {
  if (why) return { why };
  if (at == null) return { why: 'no weekly reading' };
  if (!Number.isFinite(used) || !Number.isFinite(resetsAt)) return { why: 'its weekly reading could not be parsed' };
  if (now - at > FRESH_MS) return { why: staleWhy(now - at) };
  if (resetsAt * 1000 <= now) return { why: 'its newest weekly reading is from a window that has since reset' };
  return { used, resetsAt, at };
}

// A reading in the { seven_day, at, none } shape both vendors' readers return (usage-probe.mjs
// readLoginUsage, codex-usage.mjs) as its weekly window; `pct` gives the window's use in percent.
function weeklyOf(r, pct, now) {
  if (!r || r.at == null) return weekly({ at: null }, now);
  if (r.none?.includes('seven_day')) return { why: 'its plan logs no weekly window' };
  if (!r.seven_day) return { why: 'its weekly reading could not be parsed or is from a window that has since reset' };
  return weekly({ used: pct(r.seven_day), resetsAt: r.seven_day.resetsAt, at: r.at }, now);
}
export const claudeWeekly = (r, now = Date.now()) => weeklyOf(r, (w) => w.utilization * 100, now);
export const codexWeekly = (r, now = Date.now()) => weeklyOf(r, (w) => w.used, now);

// The account's weekly reading now: for Claude, a probe on its login and then that probe's output,
// which counts only if this probe wrote it. A probe that prints nothing leaves the last one's output in
// place, and that is not a reading of now, however recent: the file is compared with what it held
// before the probe, never judged by its age, since a quick run's two probes can land within a second.
const snapshot = (file) => { try { return { at: statSync(file).mtimeMs, text: readFileSync(file, 'utf8') }; } catch { return null; } };
//   -> { after: <the probe file now, or null>, fresh: <this probe wrote it>, failed: <': why', or ''> }
export function freshProbe({ dir = usageDir(), env = process.env, login }) {
  const file = loginProbeLog(dir, login);
  const prior = snapshot(file);
  const p = probeNow({ dir, env, login });
  const after = snapshot(file);
  return { after, fresh: Boolean(after) && !(prior && prior.at === after.at && prior.text === after.text), failed: p.ok ? '' : `: the usage probe failed (${p.why})` };
}
// One small Codex call on the login, read-only and at low effort, for the session log it writes: the
// only place Codex records its allowance. Through codex-exec.mjs, so it is ended at its timeout.
//   -> '' when codex answered, else ': why'
const CODEX_PROBE_PROMPT = 'Reply with: ok';
export function codexProbeNow({ env = process.env, login, timeoutS = 120 }) {
  const tmp = mkdtempSync(join(tmpdir(), 'desk-bench-codex-probe-'));
  const last = join(tmp, 'last-message.txt');
  const call = { args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'model_reasoning_effort="low"',
    '--output-last-message', last, '--', CODEX_PROBE_PROMPT], last, cwd: tmp, timeout: timeoutS };
  const bridge = join(dirname(fileURLToPath(import.meta.url)), 'codex-exec.mjs');
  const r = spawnSync(process.execPath, [bridge], { input: JSON.stringify(call), env: { ...env, CODEX_HOME: login.dir }, encoding: 'utf8', timeout: (timeoutS + 30) * 1000 });
  rmSync(tmp, { recursive: true, force: true });
  let res = null;
  try { res = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* below */ }
  if (!res) return `: the Codex usage probe printed no result${r.error ? ` (${r.error.message})` : ''}`;
  if (res.error) return `: the Codex usage probe did not start (${res.error})`;
  if (res.timedOut) return `: the Codex usage probe timed out after ${timeoutS}s`;
  return res.code === 0 ? '' : `: the Codex usage probe exited ${res.code}`;
}
export function readWeekly(account, { dir = usageDir(), env = process.env, now = () => Date.now(), codexProbe = codexProbeNow } = {}) {
  if (account.vendor === 'codex') {
    const read = () => readCodexUsage({ login: account.login, now: now() });
    const r = read();
    // Missing or stale: nothing else in the bench writes a new Codex log before its next run would.
    if (r?.at != null && now() - r.at <= FRESH_MS) return codexWeekly(r, now());
    const failed = codexProbe({ env, login: account.login });
    const w = codexWeekly(read(), now());
    return w.why ? { why: `${w.why}${failed}` } : w;
  }
  const l = account.login.configDir ? account.login : null;
  const { after, fresh, failed } = freshProbe({ dir, env, login: l });
  if (!after) return { why: `no weekly reading${failed}` };
  if (now() - after.at > FRESH_MS) return { why: `${staleWhy(now() - after.at)}${failed}` };
  if (!fresh) return { why: `no new weekly reading${failed || ': the usage probe printed nothing'}` };
  const r = claudeWeekly(readLoginUsage({ login: l, dir, now: now() }), now());
  // Rate-limit events none of which could be read are a reading that cannot be parsed, not no reading.
  if (r.why === 'no weekly reading' && after.text.includes('"rate_limit_event"')) return { why: `its weekly reading could not be parsed${failed}` };
  return r.why ? { why: `${r.why}${failed}` } : r;
}

// ---- the ledger ------------------------------------------------------------------------------
export const ledgerPath = (dir = usageDir()) => join(dir, 'bench-quota.jsonl');

// Each run's newest line, by id.  -> [entry]
export function readLedger(path = ledgerPath()) {
  const byId = new Map();
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  for (const line of text.split('\n')) {
    try { const e = JSON.parse(line); if (e?.id && e.account) byId.set(e.id, e); } catch { /* a torn line */ }
  }
  return [...byId.values()];
}

export function record(entry, path = ledgerPath()) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

// The points the bench has used of this account's allowance in the window `now` reads: each run's
// points, and a run whose after-reading never came (the bench stopped or died) counted as the whole
// rise from its before-reading to now. With no reading now, the windows not yet reset, those runs
// counted at their known points only.
export function benchUsed(entries, account, now, at = Date.now()) {
  let used = 0;
  for (const e of entries) {
    if (e.account !== account.key) continue;
    if (now.why ? e.resetsAt * 1000 <= at : Math.abs(e.resetsAt - now.resetsAt) > SAME_WINDOW_S) continue;
    used += Number.isFinite(e.points) ? e.points : now.why ? 0 : Math.max(0, now.used - e.before);
  }
  return round1(used);
}

// One run's points: the whole rise in weekly use from before to after, or, where the window reset
// during the run, all of the new window's use.  -> { points, resetsAt }
export function runPoints(before, after) {
  if (after.resetsAt - before.resetsAt > SAME_WINDOW_S) return { points: round1(after.used), resetsAt: after.resetsAt };
  return { points: round1(Math.max(0, after.used - before.used)), resetsAt: before.resetsAt };
}

// Whether a run may start.  -> null | why it may not
export function gate({ account, reading, used, settings }) {
  if (reading.why) return unreadable(account, reading.why);
  if (used >= settings.cap) return `the bench has used ${used} of its ${settings.cap}-point cap of ${account.name}'s weekly allowance this week`;
  const left = round1(100 - reading.used);
  if (left < settings.reserve) return `${account.name} has ${left}% of its weekly allowance left, under the ${settings.reserve}% interactive reserve`;
  return null;
}

// The points line printed at every stop and in the report.
export const pointsLine = (account, used, settings, reading) =>
  `quota: ${account.name}: the bench has used ${used} of ${settings.cap} points this week${reading?.why ? '' : `, weekly use ${round1(reading.used)}%`}`;

// Before one run: reads the account, and either says why the run may not start or records its ledger
// line. `fields` sit in that line after the account's name. An OpenCode Go run needs the plan table
// (`plans`, as bench-report.mjs's loadPlans returns it) and its `arm`.
//   -> { line, why } | { line, before, entry }
export function startRun({ account, settings, ledger = ledgerPath(), env = process.env, id, fields = {}, plans, arm, now = Date.now() }) {
  if (account.vendor === GO) return goStart({ account, settings, ledger, id, fields, plans, arm, now });
  if (!metered(account.vendor)) return limitStart({ account, ledger, id, fields, now });
  const before = readWeekly(account, { env });
  const used = benchUsed(readLedger(ledger), account, before);
  const line = pointsLine(account, used, settings, before);
  const why = gate({ account, reading: before, used, settings });
  if (why) return { line, why };
  const entry = { id, account: account.key, name: account.name, ...fields, resetsAt: before.resetsAt, before: before.used, after: null, points: null, at: new Date().toISOString() };
  record(entry, ledger);
  return { line, before, entry };
}

// After one run: reads the account again and records the run's points. `label` names the run in the
// stop an unreadable reading makes. An OpenCode Go run's points come from its `result`'s
// opencode_allowance instead.  -> { quota, line } | { quota, stop }
export function endRun({ account, settings, ledger = ledgerPath(), env = process.env, before, entry, label, result, now = Date.now() }) {
  if (account.vendor === GO) return goEnd({ account, settings, ledger, before, entry, label, result, now });
  if (!metered(account.vendor)) {
    record({ ...entry, ended: new Date(now).toISOString() }, ledger);
    return { quota: { account: account.name, points: null, unmetered: true }, line: limitLine(account, entry.limit, runsThisWeek(readLedger(ledger), account, now)) };
  }
  let after = readWeekly(account, { env });
  // The reading the run started on, read again, says nothing of what the run spent.
  if (!after.why && !(after.at > before.at)) after = { why: 'no weekly reading newer than the one the run started on' };
  if (after.why) return { quota: { account: account.name, before: before.used, after: null, points: null, why: after.why }, stop: unreadable(account, after.why, ` after ${label}`) };
  const p = runPoints(before, after);
  record({ ...entry, resetsAt: p.resetsAt, after: after.used, points: p.points }, ledger);
  return { quota: { account: account.name, before: before.used, after: after.used, points: p.points }, line: pointsLine(account, benchUsed(readLedger(ledger), account, after), settings, after) };
}

// ---- OpenCode Go: the bench's own allowance ledger ------------------------------------------------
// Go publishes no meter. Each response reports `opencode.allowance`, the dollars that request counted
// against the model's monthly limit, and an OpenCode runner records them, one per response in order,
// as its result's `opencode_allowance`. The guard adds up what the bench's own runs on a model recorded
// in each rolling window and measures it against that model's monthly limit in the plan table: the
// 5-hour window is 20% of it, the week 50%, the month 100%. Use of the subscription outside the bench
// is invisible to it, so every figure says it counts the bench's own use only.
const HOUR_MS = 3_600_000;
export const GO_WINDOWS = Object.freeze([
  { name: '5-hour', hours: 5, share: 0.2 },
  { name: 'weekly', hours: 7 * 24, share: 0.5 },
  { name: 'monthly', hours: 30 * 24, share: 1 },
]);
// The shortest window a plan table row's monthly limit may have.
const MONTH_MIN_HOURS = 28 * 24;
export const OWN_USE = "the bench's own use only: Go publishes no meter";
const usd = (n) => `$${n > 0 && n < 0.01 ? n.toPrecision(2) : n.toFixed(2)}`;
const lower = (s) => String(s ?? '').toLowerCase();
const endedAt = (e) => Date.parse(e.ended ?? e.at);

// The model's monthly limit in USD: the longest window in unit `usd` on the plan table row serving the
// arm (`plans` as bench-report.mjs's loadPlans returns it).  -> { limit } | { why }
export function goLimit(plans, arm) {
  if (!plans?.ok) return { why: plans?.why ?? 'no plan table was given' };
  const m = planFor(plans, { arm: arm?.name, model: arm?.model });
  if (!m) return { why: `no row in the plan table ${plans.path} serves it` };
  const row = `the plan table's ${m.plan.provider} ${m.plan.plan} row`;
  if (m.plan.why) return { why: `${row} cannot be read: ${m.plan.why}` };
  const month = (m.served.windows ?? m.plan.windows).filter((w) => lower(w.unit) === 'usd').sort((a, b) => b.hours - a.hours)[0];
  if (!month || month.hours < MONTH_MIN_HOURS) return { why: `${row} gives it no monthly limit in usd` };
  return { limit: month.size };
}

// What one Go response body reports as its allowance, as the runner records it: null when it has none.
export const responseAllowance = (body) => body?.opencode?.allowance ?? null;

// One run's allowance from what each response reported.  -> { usd } | { why }
export function allowanceOf(values) {
  if (!Array.isArray(values) || !values.length) return { why: 'the run recorded no response carrying opencode.allowance' };
  let sum = 0;
  for (const [i, v] of values.entries()) {
    const which = `response ${i + 1} of ${values.length}`;
    if (v == null) return { why: `${which} carries no opencode.allowance` };
    if (typeof v !== 'number') return { why: `${which}'s opencode.allowance is ${JSON.stringify(v).slice(0, 80)}, a shape the bench cannot read` };
    if (!Number.isFinite(v) || v < 0) return { why: `${which}'s opencode.allowance is ${v}, not a finite non-negative number of dollars` };
    sum += v;
  }
  return { usd: sum };
}

// The bench's own use of one model's allowance in each rolling window ending at `at`, a run counted
// from when it ended (or started, until it ends). `unknown` is the first run in the month whose
// allowance was never recorded: it died, or its responses could not be read.
//   -> { windows: [{ name, hours, size, used, pct }], unknown: entry | null }
export function goUse(entries, account, limit, at = Date.now()) {
  const mine = entries.filter((e) => e.account === account.key && at - endedAt(e) < GO_WINDOWS.at(-1).hours * HOUR_MS);
  const unknown = mine.find((e) => !Number.isFinite(e.allowance)) ?? null;
  const windows = GO_WINDOWS.map((w) => {
    const used = mine.filter((e) => Number.isFinite(e.allowance) && at - endedAt(e) < w.hours * HOUR_MS).reduce((s, e) => s + e.allowance, 0);
    const size = limit * w.share;
    return { name: w.name, hours: w.hours, size, used, pct: round1((used / size) * 100) };
  });
  return { windows, unknown };
}

const unknownWhy = (e) => `run ${e.id}${e.task ? ` (task ${e.task}, arm ${e.arm})` : ''} has no allowance recorded: ${e.why ?? 'it never finished'}`;

// Whether a run on this model may start: each window under the cap and over the reserve.  -> null | why
export function goGate({ account, use, settings }) {
  if (use.unknown) return unreadable(account, unknownWhy(use.unknown));
  for (const w of use.windows) {
    if (w.pct >= settings.cap) return `the bench has used ${w.pct}% of ${account.name}'s ${w.name} allowance (${usd(w.used)} of ${usd(w.size)}), at its ${settings.cap}-point cap; ${OWN_USE}`;
    if (100 - w.pct < settings.reserve) return `${account.name} has ${round1(100 - w.pct)}% of its ${w.name} allowance left, under the ${settings.reserve}% interactive reserve; ${OWN_USE}`;
  }
  return null;
}

export const goLine = (account, use) =>
  `quota: ${account.name}: ${use.windows.map((w) => `${w.name} ${usd(w.used)} of ${usd(w.size)} (${w.pct}%)`).join(', ')}; ${OWN_USE}`;

function goStart({ account, settings, ledger, id, fields, plans, arm, now }) {
  const l = goLimit(plans, arm);
  if (l.why) return { line: `quota: ${account.name}: no monthly limit`, why: unreadable(account, l.why) };
  const use = goUse(readLedger(ledger), account, l.limit, now);
  const line = goLine(account, use);
  const why = goGate({ account, use, settings });
  if (why) return { line, why };
  const entry = { id, account: account.key, name: account.name, model: account.model, ...fields, limit: l.limit, at: new Date(now).toISOString(), allowance: null, points: null };
  record(entry, ledger);
  return { line, before: { limit: l.limit }, entry };
}

// A finished Go run's line: its dollars, and their share of each window, weekly as its points.
function goEnd({ account, ledger, before, entry, label, result, now }) {
  const ended = new Date(now).toISOString();
  const a = allowanceOf(result?.opencode_allowance);
  if (a.why) {
    record({ ...entry, ended, why: a.why }, ledger);
    return { quota: { account: account.name, model: account.model, allowance: null, points: null, why: a.why }, stop: unreadable(account, a.why, ` after ${label}`) };
  }
  const share = Object.fromEntries(GO_WINDOWS.map((w) => [w.name, round1((a.usd / (before.limit * w.share)) * 100)]));
  record({ ...entry, ended, allowance: a.usd, points: share }, ledger);
  const quota = { account: account.name, model: account.model, allowance: a.usd, points: share.weekly, windows: share, use: { usd: a.usd }, own: OWN_USE };
  return { quota, line: goLine(account, goUse(readLedger(ledger), account, before.limit, now)) };
}

// ---- a provider with no meter and no ledger: a run limit, or no run --------------------------------
// The machine profile's Sizing row `bench-run-limit-<provider>` is the most runs the bench may start on
// that provider in a rolling week. Unset, an arm on it is refused rather than run unmetered.
export const runLimitKey = (vendor) => `bench-run-limit-${vendor}`;
const WEEK_MS = 7 * 24 * HOUR_MS;
const runsThisWeek = (entries, account, at) => entries.filter((e) => e.account === account.key && at - Date.parse(e.at) < WEEK_MS).length;
const limitLine = (account, limit, runs) => `quota: ${account.name}: no meter, so the bench counts its runs: ${runs} of its ${limit}-run weekly limit`;

function limitStart({ account, ledger, id, fields, now }) {
  const key = runLimitKey(account.vendor);
  const raw = machineValue(key);
  const refused = `${account.name} has no meter and no allowance ledger the bench can read, so its arm is refused rather than run unmetered`;
  if (raw == null) return { line: `quota: ${account.name}: no meter and no run limit`, why: `${refused}: set a run limit with \`desk-env machine set ${key}=<runs a week>\`` };
  const bad = settingError(key, raw);
  if (bad) return { line: `quota: ${account.name}: no meter and no run limit`, why: `${refused}: the machine profile's ${bad}` };
  const limit = Number(String(raw).trim());
  const runs = runsThisWeek(readLedger(ledger), account, now);
  const line = limitLine(account, limit, runs);
  if (runs >= limit) return { line, why: `the bench has started ${runs} run(s) on ${account.name} this week, at its ${limit}-run limit` };
  const entry = { id, account: account.key, name: account.name, ...fields, limit, at: new Date(now).toISOString() };
  record(entry, ledger);
  return { line, before: null, entry };
}
