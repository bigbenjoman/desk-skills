// The cost cache: this month's charges from each supplier, kept on disk so a screen never waits on
// one, and the check that keeps it fresh while desk-q is open. GitHub is read with one month summary
// call per repo, and one for the whole account whose remainder is the shared line. Vercel is one
// charges call per team, split into a line per project with builds apart, and the team's plan and
// seats, each charged to a name or to shared. AWS is read with one Cost Explorer query per profile,
// grouped by service and record type.
//
// A reading covers the month of yesterday (UTC), to yesterday: every supplier lags at least a day.
// GitHub's month summary cannot stop at yesterday, so its figures include today so far. Only what
// was charged after discounts is kept, never list price. A failed call keeps the last good figures
// beside the failure. GitHub and Vercel are not read again for READ_EVERY_MS, failed or not. Every
// Cost Explorer request is billed, so an AWS profile is read at most once a UTC day, and after a
// failure not again for READ_EVERY_MS.
//
//   node cost-cache.mjs refresh [--force]   read every supplier that is due, under its lock
//   node cost-cache.mjs show                print the cache
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { readCosts, vercelText, vercelToken } from './costs.mjs';
import { takeBorrowLock } from './borrow.mjs';

export const READ_EVERY_MS = 60 * 60 * 1000;
export const GH_TIMEOUT_MS = 30 * 1000;
export const AWS_TIMEOUT_MS = 60 * 1000;
export const AWS_MAX_PAGES = 2;
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

// One CLI call that prints JSON.  -> parsed JSON; throws with the reason
const cliJson = (cmd, args, timeout, env = process.env) => new Promise((res, rej) => {
  execFile(cmd, args, { timeout, maxBuffer: 8 << 20, env }, (err, out, errOut) => {
    if (err) {
      const why = err.killed ? `timed out after ${timeout / 1000}s` : String(errOut || err.message).trim().split('\n')[0];
      rej(new Error(why || `${cmd} exited ${err.code}`));
      return;
    }
    try { res(JSON.parse(out)); } catch { rej(new Error('unexpected response: not JSON')); }
  });
});

// One `gh api` call.  -> parsed JSON; throws with the reason
export const ghApi = (path) => cliJson('gh', ['api', path], GH_TIMEOUT_MS);

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
// last month in full, kept once read, and read once for any repo that has none. A repo whose last
// call failed holds figures from part of the month, so it is read again rather than carried.
async function lastMonthOf({ sources, last, period, gh, now }) {
  const want = prevMonth(period);
  let lm = samePeriod(last?.lastMonth?.period, want) ? last.lastMonth : null;
  if (!lm && samePeriod(last?.period, want) && isFull(last.period)) {
    lm = { period: want, repos: Object.fromEntries(Object.entries(last.repos ?? {})
      .filter(([, r]) => r.total != null && !r.failed).map(([k, r]) => [k, { name: r.name, total: r.total, at: r.at }])) };
  }
  const repos = { ...(lm?.repos ?? {}) };
  for (const s of sources) {
    if (s.readable === false || repos[s.key]?.total != null) continue;
    const got = await summary(gh, s.account, want, s.key);
    repos[s.key] = got.items ? { name: s.name, total: totalOf(got.items), at: now } : { name: s.name, failed: { at: now, why: got.why } };
  }
  return { period: want, repos };
}

// ---- Vercel ----------------------------------------------------------------------------------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v
  : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

// The charges endpoint's window for a period: its first day to the start of today, UTC. `from` is
// required (a 400 without it).
export function chargesWindow({ from, to }) {
  return { from: `${from}T00:00:00.000Z`, to: new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY).toISOString() };
}
export const chargesPath = (teamId, { from, to }) =>
  `/v1/billing/charges?teamId=${encodeURIComponent(teamId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

// GET /v1/billing/charges: JSONL in the FOCUS shape, one charge per day per SKU; each day runs 07:00
// to 07:00 UTC. A line that is not JSON, a charge without its ServiceName, ChargePeriodStart or a
// numeric BilledCost, or one billed in another currency, is refused rather than read as nothing
// charged. BilledCost is what was charged; Tags.ProjectName names the project, if any.
//   -> [{ service, category, start, project, charged, quantity, unit }]
export function parseCharges(text) {
  const out = [];
  for (const [n, line] of String(text ?? '').split('\n').entries()) {
    if (!line.trim()) continue;
    let c;
    try { c = JSON.parse(line); } catch { throw new Error(`unexpected response: line ${n + 1} is not JSON`); }
    const charged = num(c?.BilledCost);
    const bad = typeof c?.ServiceName !== 'string' ? 'ServiceName'
      : Number.isNaN(Date.parse(c.ChargePeriodStart)) ? 'ChargePeriodStart' : charged == null ? 'BilledCost' : null;
    if (bad) throw new Error(`unexpected response: a charge without ${bad}`);
    if (c.BillingCurrency != null && c.BillingCurrency !== 'USD') throw new Error(`unexpected response: a charge in ${c.BillingCurrency}`);
    const project = typeof c.Tags?.ProjectName === 'string' && c.Tags.ProjectName ? c.Tags.ProjectName : null;
    out.push({ service: c.ServiceName, category: String(c.ChargeCategory ?? ''), start: Date.parse(c.ChargePeriodStart), project, charged,
      quantity: num(c.ConsumedQuantity) ?? num(c.PricingQuantity) ?? 0, unit: String(c.ConsumedUnit ?? c.PricingUnit ?? '') });
  }
  return out;
}

const isBuild = (c) => /build/i.test(c.service);
const isSeat = (c) => /seat/i.test(c.service);
const isPlan = (c) => /\bplan\b|subscription/i.test(c.service) || /^purchase$/i.test(c.category);
export const planLabel = (plan) => (plan ? `${plan[0].toUpperCase()}${plan.slice(1)}` : 'Unknown');

// One team's charges as lines, each charged to a name, or to shared as name null. A project's line
// keeps its build charge apart from its other use; a project no name claims is still a line, under
// its own project name. The plan, seats and any other charge with no project go to the team's owner.
//   owner: the one name the team bills, else null   names: { project: name }
//   -> [{ kind: 'plan', label, name, charged } | { kind: 'seats', label, name, quantity, charged }
//       | { kind: 'team', label, name, charged }
//       | { kind: 'project', project, name, build, buildQuantity, buildUnit, other, charged }]
export function teamLines(charges, { plan, owner, names }) {
  const planLine = { kind: 'plan', label: planLabel(plan), name: owner, charged: 0 };
  const team = new Map();
  const projects = new Map();
  for (const c of charges) {
    if (c.project) {
      const p = projects.get(c.project) ?? { kind: 'project', project: c.project, name: names[c.project] ?? null, build: 0, buildQuantity: 0, buildUnit: '', other: 0 };
      if (isBuild(c)) { p.build += c.charged; p.buildQuantity += c.quantity; p.buildUnit ||= c.unit; } else p.other += c.charged;
      projects.set(c.project, p);
    } else if (isSeat(c)) {
      // Seats are held, not used up: the count is the most charged at once.
      const s = team.get(`seats\u0000${c.service}`) ?? { kind: 'seats', label: c.service, name: owner, quantity: 0, charged: 0 };
      s.quantity = Math.max(s.quantity, c.quantity);
      s.charged += c.charged;
      team.set(`seats\u0000${c.service}`, s);
    } else if (isPlan(c)) planLine.charged += c.charged;
    else {
      const o = team.get(`team\u0000${c.service}`) ?? { kind: 'team', label: c.service, name: owner, charged: 0 };
      o.charged += c.charged;
      team.set(`team\u0000${c.service}`, o);
    }
  }
  const byProject = [...projects.values()].sort((a, b) => a.project.localeCompare(b.project)).map((p) => {
    const [build, other] = [cents(p.build), cents(p.other)];
    return { ...p, build, buildQuantity: qty(p.buildQuantity), other, charged: cents(build + other) };
  });
  return [planLine, ...team.values(), ...byProject].map((l) => ({ ...l, charged: cents(l.charged) }));
}

// Each name's Vercel total, and shared's, added up from the lines they are charged.
//   -> { names: { name: usd }, shared: usd }
export function vercelTotals(teams) {
  const names = {};
  let shared = 0;
  for (const l of Object.values(teams).flatMap((t) => t.lines ?? [])) {
    if (l.name == null) shared += l.charged;
    else names[l.name] = (names[l.name] ?? 0) + l.charged;
  }
  return { names: Object.fromEntries(Object.entries(names).map(([n, v]) => [n, cents(v)])), shared: cents(shared) };
}

// One GET with the Vercel CLI's token, the body kept as text: the charges endpoint answers JSONL.
//   -> the body as text; throws with the reason
export async function vercelGet(path) {
  const token = vercelToken();
  if (!token) throw new Error('not signed in to Vercel: run vercel login');
  return vercelText(path, token);
}

// One Vercel reading folded into the last one (`last`, the cache's `vercel`, or null). One call per
// team; a team whose call fails keeps its last good lines beside the failure.
// sources: costs.md's Vercel entries. vercel(path) -> the body as text.
//   -> the new `vercel`: { at, period, teams: { teamId: { team, plan, owner, at, total, lines, failed } }, names, shared }
export async function readVercel({ sources, last = null, vercel = vercelGet, now }) {
  const period = readingPeriod(now);
  const before = samePeriod(last?.period, period) ? last : null;
  const win = chargesWindow(period);
  const [from, to] = [Date.parse(win.from), Date.parse(win.to)];
  const byTeam = new Map();
  for (const s of sources) byTeam.set(s.teamId, [...(byTeam.get(s.teamId) ?? []), s]);
  const teams = {};
  for (const [teamId, list] of byTeam) {
    const names = [...new Set(list.map((e) => e.name))];
    const base = { team: list[0].team, plan: list[0].plan, owner: names.length === 1 ? names[0] : null };
    let got;
    try { got = { charges: parseCharges(await vercel(chargesPath(teamId, win))) }; }
    catch (e) { got = { why: e.message || String(e) }; }
    if (got.charges) {
      const lines = teamLines(got.charges.filter((c) => c.start >= from && c.start < to),
        { plan: base.plan, owner: base.owner, names: Object.fromEntries(list.filter((e) => e.project).map((e) => [e.project, e.name])) });
      teams[teamId] = { ...base, at: now, total: totalOf(lines), lines, failed: null };
    } else {
      const had = before?.teams?.[teamId];
      teams[teamId] = { ...base, ...(had?.lines ? { at: had.at, total: had.total, lines: had.lines } : {}), failed: { at: now, why: got.why } };
    }
  }
  return { at: now, period, teams, ...vercelTotals(teams) };
}

// ---- AWS -------------------------------------------------------------------------------------
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
const nextDay = (ymd) => utcDay(Date.parse(`${ymd}T00:00:00Z`) + DAY);
const TAX = 'Tax';

// One Cost Explorer query for a profile's period, grouped by service and record type. End is
// exclusive, so a period to the 31st ends on the 1st. --no-paginate keeps it to one request.
export const ceArgs = (profile, { from, to }, token = null) => ['ce', 'get-cost-and-usage', '--profile', profile,
  '--time-period', `Start=${from},End=${nextDay(to)}`, '--granularity', 'MONTHLY', '--metrics', 'UnblendedCost',
  '--group-by', 'Type=DIMENSION,Key=SERVICE', 'Type=DIMENSION,Key=RECORD_TYPE', '--output', 'json', '--no-paginate',
  ...(token ? ['--next-page-token', token] : [])];

// One page of that query. A group without its two keys or a USD amount is refused rather than read
// as nothing charged.  -> { groups: [{ service, type, amount }], next: page token | null }
export function parseCostAndUsage(body) {
  if (!Array.isArray(body?.ResultsByTime)) throw new Error('unexpected response: no ResultsByTime');
  const groups = [];
  for (const r of body.ResultsByTime) {
    if (!Array.isArray(r?.Groups)) throw new Error('unexpected response: a period without Groups');
    for (const g of r.Groups) {
      const [service, type] = Array.isArray(g?.Keys) ? g.Keys : [];
      if (typeof service !== 'string' || typeof type !== 'string') throw new Error('unexpected response: a group without a service and record type');
      const m = g.Metrics?.UnblendedCost;
      const amount = typeof m?.Amount === 'string' && m.Amount.trim() !== '' ? Number(m.Amount) : NaN;
      if (!Number.isFinite(amount)) throw new Error('unexpected response: a group without an UnblendedCost amount');
      if (amount !== 0 && m.Unit !== 'USD') throw new Error(`unexpected response: a cost in ${m.Unit ?? 'no unit'}, not USD`);
      groups.push({ service, type, amount });
    }
  }
  return { groups, next: typeof body.NextPageToken === 'string' && body.NextPageToken ? body.NextPageToken : null };
}

// Each service's use, what credits covered and what was charged, in dollars to the cent; every Tax
// record is one line of its own. charged is the net of all record types, so used is charged plus
// credits.  -> [{ service, used, credits, charged, tax? }], largest use first and tax last
export function awsLines(groups) {
  const by = new Map();
  for (const g of groups) {
    const service = g.type === TAX ? TAX : g.service;
    const l = by.get(service) ?? { service, net: 0, credit: 0 };
    l.net += g.amount;
    if (g.type === 'Credit') l.credit -= g.amount;
    by.set(service, l);
  }
  return [...by.values()]
    .map(({ service, net, credit }) => {
      const [charged, credits] = [cents(net), cents(credit)];
      return { service, used: cents(charged + credits), credits, charged, ...(service === TAX ? { tax: true } : {}) };
    })
    .filter((l) => l.used || l.credits || l.charged)
    .sort((a, b) => Number(!!a.tax) - Number(!!b.tax) || b.used - a.used || a.service.localeCompare(b.service));
}

// One `aws` call.  -> parsed JSON; throws with the reason
export const awsCli = (args) => cliJson('aws', args, AWS_TIMEOUT_MS, { ...process.env, AWS_PAGER: '' });

// A profile's groups for the period, in at most AWS_MAX_PAGES requests.
async function costAndUsage(aws, profile, period) {
  const groups = [];
  let token = null;
  for (let page = 0; page < AWS_MAX_PAGES; page++) {
    const got = parseCostAndUsage(await aws(ceArgs(profile, period, token)));
    groups.push(...got.groups);
    token = got.next;
    if (!token) return groups;
  }
  throw new Error(`more than ${AWS_MAX_PAGES} pages of results`);
}

// Due when the profile has no good reading this UTC day and no failed attempt in the last READ_EVERY_MS.
export const profileDue = (rec, now) => !(rec?.at != null && utcDay(rec.at) === utcDay(now))
  && !(rec?.failed && now - rec.failed.at < READ_EVERY_MS);

// One AWS reading folded into the last one (`last`, the cache's `aws`, or null): each due profile is
// read (with force, every one) and every other keeps its record. An organisation profile's figures
// include its linked accounts. sources: costs.md's AWS entries. aws(args) -> parsed body.
//   -> the new `aws`: { at, profiles: { <profile>: { profile, name, repo, credit, at, period, total, lines, failed } },
//        names: awsByName's figures per name }
export async function readAws({ sources, last = null, aws = awsCli, now, force = false }) {
  const profiles = {};
  for (const s of sources) {
    const had = last?.profiles?.[s.key];
    const base = { profile: s.key, name: s.name, repo: s.repo ?? null, credit: s.credit ?? null };
    if (!force && !profileDue(had, now)) { profiles[s.key] = { ...had, ...base }; continue; }
    const period = readingPeriod(now);
    try {
      const lines = awsLines(await costAndUsage(aws, s.key, period));
      profiles[s.key] = { ...base, at: now, period, total: totalOf(lines), lines, failed: null };
    } catch (e) {
      const keep = had?.lines ? { at: had.at, period: had.period, total: had.total, lines: had.lines } : {};
      profiles[s.key] = { ...base, ...keep, failed: { at: now, why: e.message || String(e) } };
    }
  }
  return { at: now, profiles, names: awsByName({ profiles }) };
}

// The AWS figures per name, its profiles' lines merged by service.
//   -> { <name>: { repo, profiles: [profile], total, lines } }
export function awsByName(aws) {
  const out = {};
  for (const p of Object.values(aws?.profiles ?? {})) {
    const n = (out[p.name] ??= { repo: p.repo, profiles: [], total: 0, lines: [] });
    n.profiles.push(p.profile);
    for (const l of p.lines ?? []) {
      const m = n.lines.find((x) => x.service === l.service);
      if (!m) { n.lines.push({ ...l }); continue; }
      for (const k of ['used', 'credits', 'charged']) m[k] = cents(m[k] + l[k]);
    }
    n.total = totalOf(n.lines);
  }
  return out;
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

// Each supplier's sources in costs.md.
const sourcesOf = (costs) => ({
  github: costs.entries.filter((e) => e.supplier === 'github'),
  vercel: costs.entries.filter((e) => e.supplier === 'vercel' && e.teamId),
  aws: costs.entries.filter((e) => e.supplier === 'aws'),
});

// GitHub and Vercel are due with no reading, failed or not, in the last READ_EVERY_MS; AWS when any
// profile is.
const hourly = (sources, had, now) => !(now - (had?.at ?? 0) < READ_EVERY_MS);
const DUE = {
  github: hourly,
  vercel: hourly,
  aws: (sources, had, now) => sources.some((s) => profileDue(had?.profiles?.[s.key], now)),
};
const NOT_DUE = { github: 'read under an hour ago', vercel: 'read under an hour ago', aws: 'every profile read today, or failed under an hour ago' };

// The suppliers with sources that are due. Workers running or not makes no difference.
//   -> ['github', 'aws', …]
export function dueSuppliers({ costs = readCosts(E.costsPath()), cache = readCache(), now }) {
  if (!costs.exists) return [];
  return Object.entries(sourcesOf(costs))
    .filter(([s, list]) => list.length && DUE[s](list, cache?.[s], now))
    .map(([s]) => s);
}

const READERS = { github: readGithub, vercel: readVercel, aws: readAws };

// Read every due supplier, one at a time per supplier however many callers race: each takes its
// supplier's lock and checks it is still due under it. Another supplier may be read meanwhile, so
// the reading goes into the cache as it is on disk then, under the cache's own lock.
//   -> { github: 'read' | why not, … }
export async function refresh({ dir = costDir(), lockDir = E.lockDir(), costs = readCosts(E.costsPath()), gh = ghApi, vercel = vercelGet, aws = awsCli, now = Date.now(), force = false } = {}) {
  const out = {};
  if (!costs.exists) return out;
  for (const [supplier, sources] of Object.entries(sourcesOf(costs))) {
    if (!sources.length) continue;
    const lock = await takeBorrowLock({ dir: lockDir, name: `desk-cost-${supplier}.lock.d`, waitMs: 0 });
    if (!lock.ok) { out[supplier] = 'another reading is running'; continue; }
    try {
      const cache = readCache(dir) ?? { v: 1 };
      if (!force && !dueSuppliers({ costs, cache, now }).includes(supplier)) { out[supplier] = NOT_DUE[supplier]; continue; }
      const read = await READERS[supplier]({ sources, last: cache[supplier] ?? null, gh, vercel, aws, now, force });
      const write = await takeBorrowLock({ dir: lockDir, name: 'desk-cost-cache.lock.d', waitMs: 10000 });
      if (!write.ok) { out[supplier] = 'the cache stayed locked'; continue; }
      try { writeCache({ ...(readCache(dir) ?? { v: 1 }), [supplier]: read }, dir); } finally { write.release(); }
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
