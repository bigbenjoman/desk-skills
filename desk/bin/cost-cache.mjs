// The cost cache: this month's charges from each supplier, kept on disk so a screen never waits on
// one, and the check that keeps it fresh while desk-q is open. GitHub is read here; one month
// summary call per repo, and one for the whole account whose remainder is the shared line.
//
// A reading covers the month of yesterday (UTC), to yesterday: every supplier lags at least a day.
// GitHub's month summary cannot stop at yesterday, so its figures include today so far. Only what
// was charged after discounts is kept, never list price. A failed call keeps the last good figures
// beside the failure; a reading, failed or not, is not tried again for READ_EVERY_MS.
//
//   node cost-cache.mjs refresh [--force]   read every supplier that is due, under its lock
//   node cost-cache.mjs show                print the cache
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { readCosts } from './costs.mjs';
import { takeBorrowLock } from './borrow.mjs';

export const READ_EVERY_MS = 60 * 60 * 1000;
export const GH_TIMEOUT_MS = 30 * 1000;
const DAY = 24 * 60 * 60 * 1000;
export const costDir = () => E.expandHome(process.env.DESK_COST_DIR ?? join(E.HOME, '.desk-autopilot', 'costs'));
export const cachePath = (dir = costDir()) => join(dir, 'cache.json');

// ---- months ----------------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
export const fullMonth = (year, month) => ({ year, month, from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay(year, month))}` });
export const prevMonth = ({ year, month }) => (month === 1 ? fullMonth(year - 1, 12) : fullMonth(year, month - 1));
export const isFull = (p) => p?.to === fullMonth(p.year, p.month).to;
const samePeriod = (a, b) => a?.year === b?.year && a?.month === b?.month;

// The period a reading at `now` covers: the month of yesterday (UTC), from its first day to yesterday.
export function readingPeriod(now) {
  const y = new Date(now - DAY);
  const p = fullMonth(y.getUTCFullYear(), y.getUTCMonth() + 1);
  return { ...p, to: y.toISOString().slice(0, 10) };
}

// "1–26 October 2026 (UTC)"
export function coverLabel(p) {
  if (!p) return null;
  const name = new Date(Date.UTC(p.year, p.month - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  return `1–${Number(p.to.slice(8))} ${name} ${p.year} (UTC)`;
}

// ---- GitHub ----------------------------------------------------------------------------------
const cents = (n) => Math.round(n * 100) / 100;
const qty = (n) => Math.round(n * 1000) / 1000;
const NUMS = ['grossQuantity', 'grossAmount', 'discountQuantity', 'discountAmount', 'netQuantity', 'netAmount'];

// GET /users/<login>/settings/billing/usage/summary: one usage item per SKU. An item missing its SKU
// or any amount is refused rather than read as nothing charged.
//   -> [{ sku, product, unit, quantity, charged, discount: 'full' | 'part' | 'none' }], one per SKU
export function parseSummary(body) {
  if (!Array.isArray(body?.usageItems)) throw new Error('unexpected response: no usageItems');
  const by = new Map();
  for (const i of body.usageItems) {
    const bad = typeof i?.sku !== 'string' ? 'sku' : NUMS.find((k) => typeof i[k] !== 'number' || !Number.isFinite(i[k]));
    if (bad) throw new Error(`unexpected response: a usage item without ${bad}`);
    const s = by.get(i.sku) ?? { sku: i.sku, product: String(i.product ?? '').toLowerCase(), unit: String(i.unitType ?? ''), gross: 0, quantity: 0, charged: 0 };
    s.gross += i.grossAmount;
    s.quantity += i.grossQuantity;
    s.charged += i.netAmount;
    by.set(i.sku, s);
  }
  return [...by.values()].map(({ gross, ...s }) => ({
    ...s, quantity: qty(s.quantity), charged: cents(s.charged),
    discount: gross > 0 && cents(s.charged) === 0 ? 'full' : cents(s.charged) < cents(gross) ? 'part' : 'none',
  }));
}
export const totalOf = (items) => cents(items.reduce((a, i) => a + i.charged, 0));

// The account's figures less every repo's, per SKU: what no listed repo owns.
export function sharedItems(account, repos) {
  const out = [];
  for (const a of account) {
    const used = repos.flat().filter((r) => r.sku === a.sku);
    const quantity = qty(Math.max(0, a.quantity - used.reduce((s, r) => s + r.quantity, 0)));
    const charged = cents(Math.max(0, a.charged - used.reduce((s, r) => s + r.charged, 0)));
    if (quantity > 0 || charged > 0) out.push({ sku: a.sku, product: a.product, unit: a.unit, quantity, charged, discount: a.discount });
  }
  return out;
}

export const summaryPath = (login, { year, month }, repo) =>
  `/users/${login}/settings/billing/usage/summary?year=${year}&month=${month}${repo ? `&repository=${repo}` : ''}`;

// One `gh api` call.  -> parsed JSON; throws with the reason
export const ghApi = (path) => new Promise((res, rej) => {
  execFile('gh', ['api', path], { timeout: GH_TIMEOUT_MS, maxBuffer: 8 << 20 }, (err, out, errOut) => {
    if (err) {
      const why = err.killed ? `timed out after ${GH_TIMEOUT_MS / 1000}s` : String(errOut || err.message).trim().split('\n')[0];
      rej(new Error(why || `gh exited ${err.code}`));
      return;
    }
    try { res(JSON.parse(out)); } catch { rej(new Error('unexpected response: not JSON')); }
  });
});

async function summary(gh, login, period, repo) {
  try { return { items: parseSummary(await gh(summaryPath(login, period, repo))) }; }
  catch (e) { return { why: e.message || String(e) }; }
}

// One GitHub reading folded into the last one (`last`, the cache's `github`, or null).
// sources: costs.md's GitHub entries. gh(path) -> parsed body.
//   -> the new `github`: { at, period, repos, shared, lastMonth }
export async function readGithub({ sources, last = null, gh = ghApi, now }) {
  const period = readingPeriod(now);
  const before = samePeriod(last?.period, period) ? last : null;
  const repos = {};
  const shared = {};
  const read = {};
  const short = new Set();
  for (const s of sources) {
    if (s.readable === false) { repos[s.key] = { name: s.name, cantRead: { account: s.account } }; continue; }
    const got = await summary(gh, s.account, period, s.key);
    const had = before?.repos?.[s.key];
    if (got.items) {
      repos[s.key] = { name: s.name, at: now, total: totalOf(got.items), items: got.items, failed: null };
      (read[s.account] ??= []).push(got.items);
    } else {
      repos[s.key] = { name: s.name, ...(had?.items ? { at: had.at, total: had.total, items: had.items } : {}), failed: { at: now, why: got.why } };
      short.add(s.account);
    }
  }
  for (const account of [...new Set(sources.filter((s) => s.readable !== false).map((s) => s.account))]) {
    const had = before?.shared?.[account];
    const keep = had?.items ? { at: had.at, total: had.total, items: had.items } : {};
    if (short.has(account)) { shared[account] = { ...keep, failed: { at: now, why: 'a repo on this account could not be read' } }; continue; }
    const got = await summary(gh, account, period);
    if (!got.items) { shared[account] = { ...keep, failed: { at: now, why: got.why } }; continue; }
    const items = sharedItems(got.items, read[account]);
    shared[account] = { at: now, total: totalOf(items), items, failed: null };
  }
  return { at: now, period, repos, shared, lastMonth: await lastMonthOf({ sources, last, period, gh, now }) };
}

// Last month's charged total per repo, for comparison: carried over when the previous reading was
// last month in full, kept once read, and read once for any repo that has none.
async function lastMonthOf({ sources, last, period, gh, now }) {
  const want = prevMonth(period);
  let lm = samePeriod(last?.lastMonth?.period, want) ? last.lastMonth : null;
  if (!lm && samePeriod(last?.period, want) && isFull(last.period)) {
    lm = { period: want, repos: Object.fromEntries(Object.entries(last.repos ?? {})
      .filter(([, r]) => r.total != null).map(([k, r]) => [k, { name: r.name, total: r.total, at: r.at }])) };
  }
  const repos = { ...(lm?.repos ?? {}) };
  for (const s of sources) {
    if (s.readable === false || repos[s.key]?.total != null) continue;
    const got = await summary(gh, s.account, want, s.key);
    repos[s.key] = got.items ? { name: s.name, total: totalOf(got.items), at: now } : { name: s.name, failed: { at: now, why: got.why } };
  }
  return { period: want, repos };
}

// ---- the cache -------------------------------------------------------------------------------
export function readCache(dir = costDir()) {
  try { return JSON.parse(readFileSync(cachePath(dir), 'utf8')); } catch { return null; }
}
function writeCache(cache, dir) {
  mkdirSync(dir, { recursive: true });
  const part = `${cachePath(dir)}.part`;
  writeFileSync(part, `${JSON.stringify(cache, null, 2)}\n`);
  renameSync(part, cachePath(dir));
}

// Each supplier's sources in costs.md; only GitHub is read so far.
const sourcesOf = (costs) => ({ github: costs.entries.filter((e) => e.supplier === 'github') });

// A supplier is due when it has sources and no reading, failed or not, in the last READ_EVERY_MS.
// Workers running or not makes no difference.  -> ['github', …]
export function dueSuppliers({ costs = readCosts(E.costsPath()), cache = readCache(), now }) {
  if (!costs.exists) return [];
  return Object.entries(sourcesOf(costs))
    .filter(([s, list]) => list.length && !(now - (cache?.[s]?.at ?? 0) < READ_EVERY_MS))
    .map(([s]) => s);
}

const READERS = { github: readGithub };

// Read every due supplier, one at a time per supplier however many callers race: each takes its
// supplier's lock and checks it is still due under it.  -> { github: 'read' | why not, … }
export async function refresh({ dir = costDir(), lockDir = E.lockDir(), costs = readCosts(E.costsPath()), gh = ghApi, now = Date.now(), force = false } = {}) {
  const out = {};
  if (!costs.exists) return out;
  for (const [supplier, sources] of Object.entries(sourcesOf(costs))) {
    if (!sources.length) continue;
    const lock = await takeBorrowLock({ dir: lockDir, name: `desk-cost-${supplier}.lock.d`, waitMs: 0 });
    if (!lock.ok) { out[supplier] = 'another reading is running'; continue; }
    try {
      const cache = readCache(dir) ?? { v: 1 };
      if (!force && !dueSuppliers({ costs, cache, now }).includes(supplier)) { out[supplier] = 'read under an hour ago'; continue; }
      cache[supplier] = await READERS[supplier]({ sources, last: cache[supplier] ?? null, gh, now });
      writeCache(cache, dir);
      out[supplier] = 'read';
    } finally { lock.release(); }
  }
  return out;
}

// desk-q's check: start one reading in the background when any supplier is due, and never wait.
export function startRefresh({ now = Date.now(), due = dueSuppliers({ now }), env = process.env } = {}) {
  if (!due.length) return { started: false };
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'refresh'], { env, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return { started: true };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'refresh') console.log(JSON.stringify(await refresh({ force: rest.includes('--force') })));
  else if (cmd === 'show') console.log(JSON.stringify(readCache(), null, 2));
  else { console.error('usage: cost-cache.mjs refresh [--force] | show'); process.exit(2); }
}
