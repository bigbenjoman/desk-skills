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
// (codex-usage.mjs). Either is refused when older than FRESH_MS. The points each run used are kept per
// computer in <usage dir>/bench-quota.jsonl, one line per run, written before the run starts (its
// `after` and `points` null) and again once it ends; the last line for a run's id stands.
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { machineValue } from './desk-env.mjs';
import { BENCH_CAP_KEY, BENCH_RESERVE_KEY, benchSettingError as settingError } from './machine.mjs';
import { loginProbeLog, probeNow, readLoginUsage, usageDir } from './usage-probe.mjs';
import { loginOf } from './claude-logins.mjs';
import { defaultLogin, login as makeLogin } from './logins.mjs';
import { readCodexUsage } from './codex-usage.mjs';

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

// Which vendor's allowance an arm spends: Codex for a GPT or Codex model, Claude otherwise.
export const armVendor = (arm) => (/^(gpt-|codex)/i.test(arm?.model ?? '') ? 'codex' : 'claude');

// The account a run spends: the Claude login its environment points at, or the signed-in Codex login.
//   -> { vendor, label, login, key, name }
export function accountFor(vendor, env = process.env) {
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
export function readWeekly(account, { dir = usageDir(), env = process.env, now = () => Date.now() } = {}) {
  if (account.vendor === 'codex') return codexWeekly(readCodexUsage({ login: account.login, now: now() }), now());
  const l = account.login.configDir ? account.login : null;
  const file = loginProbeLog(dir, l);
  const prior = snapshot(file);
  const p = probeNow({ dir, env, login: l });
  const failed = p.ok ? '' : `: the usage probe failed (${p.why})`;
  const after = snapshot(file);
  if (!after) return { why: `no weekly reading${failed}` };
  if (now() - after.at > FRESH_MS) return { why: `${staleWhy(now() - after.at)}${failed}` };
  if (prior && prior.at === after.at && prior.text === after.text) return { why: `no new weekly reading${failed || ': the usage probe printed nothing'}` };
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
// line. `fields` sit in that line after the account's name.  -> { line, why } | { line, before, entry }
export function startRun({ account, settings, ledger = ledgerPath(), env = process.env, id, fields = {} }) {
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
// stop an unreadable reading makes.  -> { quota, line } | { quota, stop }
export function endRun({ account, settings, ledger = ledgerPath(), env = process.env, before, entry, label }) {
  let after = readWeekly(account, { env });
  // The reading the run started on, read again, says nothing of what the run spent.
  if (!after.why && !(after.at > before.at)) after = { why: 'no weekly reading newer than the one the run started on' };
  if (after.why) return { quota: { account: account.name, before: before.used, after: null, points: null, why: after.why }, stop: unreadable(account, after.why, ` after ${label}`) };
  const p = runPoints(before, after);
  record({ ...entry, resetsAt: p.resetsAt, after: after.used, points: p.points }, ledger);
  return { quota: { account: account.name, before: before.used, after: after.used, points: p.points }, line: pointsLine(account, benchUsed(readLedger(ledger), account, after), settings, after) };
}
