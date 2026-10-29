// The cost cache: this month's charges from each supplier, kept on disk so a screen never waits on
// one, and the check that keeps it fresh while desk-q is open. GitHub is read with one month summary
// call per repo, and one for the whole account whose remainder is the shared line. Vercel is one
// charges call per team, split into a line per project with builds apart, and the team's plan and
// seats, each charged to a name or to shared. AWS is read with one Cost Explorer query per profile,
// grouped by service and record type. Neon is read as use per project, one consumption query per
// org, and priced with costs.md's prices whenever it is shown.
//
// A reading covers the month of yesterday (UTC), to yesterday: every supplier lags at least a day.
// GitHub's month summary cannot stop at yesterday, so its figures include today so far. Only what
// was charged after discounts is kept, never list price. A failed call keeps the last good figures
// beside the failure. GitHub and Vercel are not read again for READ_EVERY_MS, failed or not. Every
// Cost Explorer request is billed, so an AWS profile is read at most once a UTC day, and after a
// failure not again for READ_EVERY_MS; a Neon org the same.
//
//   node cost-cache.mjs refresh [--force]   read every supplier that is due, under its lock
//   node cost-cache.mjs show                print the cache
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { readCosts, vercelText, vercelToken, neonKey, neonKeyPath, tilde, NEON_UNITS } from './costs.mjs';
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

// One `aws` call, with the CLI's own retries off: each retry is another billed request.
//   -> parsed JSON; throws with the reason
export const awsCli = (args) => cliJson('aws', args, AWS_TIMEOUT_MS, { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1' });

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

// The account a profile signs in to, and the other accounts in its organisation when it is the
// management account: a delegated administrator can list the accounts too, but its Cost Explorer
// holds only its own. Every call is free; a failed one leaves that part unknown (null) rather than failing.
//   -> { account: id | null, linked: [id] | null }
async function identify(aws, profile) {
  const call = (args) => aws([...args, '--profile', profile, '--output', 'json']);
  const account = await call(['sts', 'get-caller-identity'])
    .then((b) => (typeof b?.Account === 'string' ? b.Account : null), () => null);
  if (!account) return { account: null, linked: null };
  const manages = await call(['organizations', 'describe-organization'])
    .then((b) => b?.Organization?.MasterAccountId === account, () => null);
  if (!manages) return { account, linked: manages === false ? [] : null };
  const linked = await call(['organizations', 'list-accounts'])
    .then((b) => (Array.isArray(b?.Accounts) ? b.Accounts.map((a) => a?.Id).filter((id) => typeof id === 'string' && id !== account) : null), () => null);
  return { account, linked };
}

// What a profile is known to sign in to: this reading's identity, with any part it could not learn
// kept from the cache's record while the account is the same one.
const knownIdentity = (got, was) => {
  const account = got.account ?? was?.account ?? null;
  return { account, linked: got.linked ?? (account && account === was?.account ? was?.linked : null) ?? [] };
};

// The profile whose figures already hold p's account, under any name: the organisation that links
// it, else an earlier profile that signs in to the same account. list: [{ profile, name, account, linked }]
//   -> profile | null
function coveredBy(p, list) {
  if (!p?.account) return null;
  const peers = list.filter((q) => q.profile !== p.profile && q.account);
  const org = peers.find((q) => q.linked?.includes(p.account));
  if (org) return org.profile;
  const at = list.findIndex((q) => q.profile === p.profile);
  return peers.find((q) => q.account === p.account && list.findIndex((x) => x.profile === q.profile) < at)?.profile ?? null;
}

// costs.md's AWS profiles as the cache last knew them, for coveredBy.
const knownAccounts = (sources, profiles) => sources.map((s) => ({ profile: s.key, name: s.name,
  account: profiles?.[s.key]?.account ?? null, linked: profiles?.[s.key]?.linked ?? [] }));
// A profile recorded as covered whose cover no longer holds it has to be read itself.
const uncovered = (sources, profiles) => {
  const list = knownAccounts(sources, profiles);
  return list.some((p) => profiles?.[p.profile]?.covered && !coveredBy(p, list));
};
// A profile read before accounts were recorded has to be identified, whether or not it is due.
const unidentified = (rec) => rec != null && !('account' in rec);

// One AWS reading folded into the last one (`last`, the cache's `aws`, or null): each due profile is
// read (with force, every one) and every other keeps its record. An organisation profile's figures
// include its linked accounts, so a profile another one covers (coveredBy) makes no Cost Explorer
// request and holds no figures. sources: costs.md's AWS entries. aws(args) -> parsed body.
//   -> the new `aws`: { at, profiles: { <profile>: { profile, name, repo, credit, account, linked, covered,
//        at, period, total, lines, failed } }, names: awsByName's figures per name }
export async function readAws({ sources, last = null, aws = awsCli, now, force = false }) {
  const had = Object.fromEntries(sources.map((s) => [s.key, last?.profiles?.[s.key]]));
  const due = Object.fromEntries(sources.map((s) => [s.key, force || profileDue(had[s.key], now)]));
  const ids = { ...had };
  for (const s of sources) {
    if (due[s.key] || unidentified(had[s.key])) ids[s.key] = knownIdentity(await identify(aws, s.key), had[s.key]);
  }
  const list = knownAccounts(sources, ids);
  const profiles = {};
  for (const [i, s] of sources.entries()) {
    const was = had[s.key];
    const id = { account: list[i].account, linked: list[i].linked };
    const base = { profile: s.key, name: s.name, repo: s.repo ?? null, credit: s.credit ?? null, ...id };
    const by = coveredBy(list[i], list);
    if (by) { profiles[s.key] = { ...base, covered: by, at: due[s.key] ? now : was?.at ?? now, failed: null }; continue; }
    if (!due[s.key] && !was?.covered) { profiles[s.key] = { ...was, ...base }; continue; }
    const period = readingPeriod(now);
    try {
      const lines = awsLines(await costAndUsage(aws, s.key, period));
      profiles[s.key] = { ...base, covered: null, at: now, period, total: totalOf(lines), lines, failed: null };
    } catch (e) {
      const keep = was?.lines ? { at: was.at, period: was.period, total: was.total, lines: was.lines } : {};
      profiles[s.key] = { ...base, covered: null, ...keep, failed: { at: now, why: e.message || String(e) } };
    }
  }
  return { at: now, profiles, names: awsByName({ profiles }, readingPeriod(now)) };
}

// The AWS figures per name for one period, its profiles' lines merged by service. A profile whose
// last good figures are from another month is left out of the total and named under stale; one whose
// last attempt failed is named under failed; one another profile covers, under covered with that profile.
//   -> { <name>: { repo, period, profiles: [profile], stale: [profile], failed: [profile], covered: [{ profile, by }], total, lines } }
export function awsByName(aws, period) {
  const out = {};
  for (const p of Object.values(aws?.profiles ?? {})) {
    const n = (out[p.name] ??= { repo: p.repo, period, profiles: [], stale: [], failed: [], covered: [], total: 0, lines: [] });
    n.profiles.push(p.profile);
    if (p.covered) { n.covered.push({ profile: p.profile, by: p.covered }); continue; }
    if (p.failed) n.failed.push(p.profile);
    if (p.lines && !samePeriod(p.period, period)) { n.stale.push(p.profile); continue; }
    for (const l of p.lines ?? []) {
      const m = n.lines.find((x) => x.service === l.service);
      if (!m) { n.lines.push({ ...l }); continue; }
      for (const k of ['used', 'credits', 'charged']) m[k] = cents(m[k] + l[k]);
    }
    n.total = totalOf(n.lines);
  }
  return out;
}

// ---- Neon ------------------------------------------------------------------------------------
export const NEON_TIMEOUT_MS = 30 * 1000;
export const NEON_MAX_PAGES = 20;
export const NEON_METRICS = Object.freeze(NEON_UNITS.flatMap((u) => u.metrics));
const neonApi = () => (process.env.DESK_NEON_API || 'https://console.neon.tech/api/v2').replace(/\/$/, '');
const isFreePlan = (plan) => plan === 'free';

// One page of an org's use for a period, a day at a time, from its first day to the start of today, UTC.
export function consumptionPath(orgId, period, cursor = null) {
  const { from, to } = chargesWindow(period);
  const q = new URLSearchParams({ from, to, granularity: 'daily', org_id: orgId, metrics: NEON_METRICS.join(','), ...(cursor ? { cursor } : {}) });
  return `/consumption_history/v2/projects?${q}`;
}

// GET /consumption_history/v2/projects: each project's periods, each period's days, each day's
// metrics. A metric whose value is zero may be left out, so a missing one is 0. A project without its
// id, or a metric without its name or a numeric value, is refused rather than read as nothing used.
//   -> { projects: [{ project, usage: { metric: sum } }], cursor: next page's | null }
export function parseConsumption(body) {
  const list = (v, what) => { if (!Array.isArray(v)) throw new Error(`unexpected response: no ${what}`); return v; };
  const projects = [];
  for (const p of list(body?.projects, 'projects')) {
    if (typeof p?.project_id !== 'string') throw new Error('unexpected response: a project without project_id');
    const usage = {};
    for (const period of list(p.periods, 'periods')) {
      for (const day of list(period?.consumption, 'consumption')) {
        for (const m of list(day?.metrics, 'metrics')) {
          const v = num(m?.value);
          if (typeof m?.metric_name !== 'string' || v == null) throw new Error('unexpected response: a metric without a name and value');
          usage[m.metric_name] = (usage[m.metric_name] ?? 0) + v;
        }
      }
    }
    projects.push({ project: p.project_id, usage });
  }
  const cursor = body.pagination?.cursor;
  return { projects, cursor: typeof cursor === 'string' && cursor ? cursor : null };
}

// One GET with the Neon API key.  -> parsed JSON; throws with the reason, `refused` on a 401 or 403
export async function neonGet(path, key) {
  let r;
  try { r = await fetch(`${neonApi()}${path}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(NEON_TIMEOUT_MS) }); }
  catch (e) { throw new Error(e?.name === 'TimeoutError' ? `timed out after ${NEON_TIMEOUT_MS / 1000}s` : `could not reach Neon: ${e?.message ?? e}`); }
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`HTTP ${r.status}: Neon refused the API key`), { refused: true });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  try { return await r.json(); } catch { throw new Error('unexpected response: not JSON'); }
}

// An org's use for the period, page by page.  -> { project: { metric: sum } }
async function orgUsage(neon, key, orgId, period) {
  const usage = {};
  let cursor = null;
  for (let page = 0; page < NEON_MAX_PAGES; page++) {
    const got = parseConsumption(await neon(consumptionPath(orgId, period, cursor), key));
    for (const p of got.projects) {
      const u = (usage[p.project] ??= {});
      for (const [m, v] of Object.entries(p.usage)) u[m] = (u[m] ?? 0) + v;
    }
    if (!got.projects.length || !got.cursor || got.cursor === cursor) return usage;
    cursor = got.cursor;
  }
  throw new Error(`more than ${NEON_MAX_PAGES} pages of projects`);
}

// The orgs costs.md lists on a paid plan: the only ones read.
const paidOrgs = (sources) => [...new Set(sources.filter((s) => !isFreePlan(s.plan)).map((s) => s.orgId))];
// A project's charge in cents, and the price keys its use has none for.
function projectCents(usage, prices) {
  let c = 0;
  const missing = [];
  for (const u of NEON_UNITS) {
    const units = u.metrics.reduce((a, m) => a + (usage?.[m] ?? 0), 0) / u.per;
    if (!units) continue;
    if (Number.isFinite(prices?.[u.key])) c += units * prices[u.key] * 100;
    else missing.push(u.key);
  }
  return { c, missing };
}

// Each name's Neon charge for the reading's month, priced from costs.md: its own projects' use in
// billing units times its row's prices, plus the org's plan and monthly fee (its first row's),
// charged to the org's one name or else to shared. A shared org's fee is not split: no even or by-use
// share is the org's real bill to any one name, and Vercel's plan fee goes to shared the same way.
// An org on the free plan is $0. An org that can't be read, or whose use has no price,
// gives its names no figure but the reason.
//   neon: the cache's `neon`   sources: costs.md's Neon entries
//   -> { names: { name: { name, at, failed, total?, cantRead, free } }, shared: usd | null, sharedLines: [{ label, charged }] }
export function neonCharges(neon, sources) {
  const byOrg = new Map();
  for (const s of sources) byOrg.set(s.orgId, [...(byOrg.get(s.orgId) ?? []), s]);
  const rows = {};
  const row = (n) => (rows[n] ??= { name: n, c: 0, figure: true, at: null, failed: null, cantRead: null, free: true });
  let shared = null;
  const sharedLines = [];
  const file = tilde(neonKeyPath());
  for (const [orgId, list] of byOrg) {
    const own = [...new Set(list.map((e) => e.name))];
    const { plan, fee } = list[0];
    // An org on the free plan is never read, so it gives its names no read time to go stale.
    if (isFreePlan(plan)) { for (const n of own) row(n); continue; }
    const rec = neon?.orgs?.[orgId];
    for (const n of own) {
      const r = row(n);
      r.free = false;
      if (rec?.at != null) r.at = r.at == null ? rec.at : Math.min(r.at, rec.at);
      if (rec?.failed && (r.failed?.at ?? 0) < rec.failed.at) r.failed = rec.failed;
      if (rec?.cantRead) r.cantRead = { supplier: 'neon', text: rec.cantRead === 'refused' ? `can't read: Neon refused the API key in ${file}` : `can't read: no Neon API key in ${file}` };
      if (rec?.cantRead || !rec?.usage || !samePeriod(rec.period, neon?.period)) r.figure = false;
    }
    if (!rec?.usage || rec.cantRead || !samePeriod(rec.period, neon?.period)) continue;
    for (const e of list.filter((x) => x.project)) {
      const got = projectCents(rec.usage[e.project], e.prices);
      row(e.name).c += got.c;
      if (got.missing.length) {
        row(e.name).figure = false;
        row(e.name).cantRead ??= { supplier: 'neon', text: `can't price: no Neon price for ${got.missing.join(', ')} in costs.md` };
      }
    }
    if (Number.isFinite(fee) && fee > 0) {
      if (own.length === 1) row(own[0]).c += fee * 100;
      else {
        shared = cents((shared ?? 0) + fee);
        sharedLines.push({ label: `${planLabel(plan)} plan`, charged: cents(fee) });
      }
    }
  }
  const names = Object.fromEntries(Object.values(rows).map(({ c, figure, ...r }) => [r.name, { ...r, ...(figure ? { total: Math.round(c) / 100 } : {}) }]));
  return { names, shared, sharedLines };
}

// One Neon reading folded into the last one (`last`, the cache's `neon`, or null): each due org on a
// paid plan is read once, however many names it bills (with force, every one), and every other keeps
// its record. An org on the free plan makes no call: Neon answers only paid plans.
// sources: costs.md's Neon entries. neon(path, key) -> parsed body.
//   -> the new `neon`: { at, period, orgs: { orgId: { at, period, usage: { project: { metric: sum } }, cantRead, failed } },
//        names, shared, sharedLines (neonCharges) }
export async function readNeon({ sources, last = null, neon = neonGet, now, force = false, key = neonKey() }) {
  const period = readingPeriod(now);
  const orgs = {};
  for (const orgId of paidOrgs(sources)) {
    const was = last?.orgs?.[orgId];
    if (!force && was && !profileDue(was, now)) { orgs[orgId] = was; continue; }
    const keep = was?.usage ? { at: was.at, period: was.period, usage: was.usage } : {};
    if (!key) { orgs[orgId] = { ...keep, cantRead: 'missing', failed: { at: now, why: `no Neon API key in ${tilde(neonKeyPath())}` } }; continue; }
    try { orgs[orgId] = { at: now, period, usage: await orgUsage(neon, key, orgId, period), cantRead: null, failed: null }; }
    catch (e) { orgs[orgId] = { ...keep, cantRead: e.refused ? 'refused' : null, failed: { at: now, why: e.message || String(e) } }; }
  }
  const read = { at: now, period, orgs };
  return { ...read, ...neonCharges(read, sources) };
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

// ---- what was charged, by name -------------------------------------------------------------------
// Where each supplier's reading keeps its figures: for GitHub, entries `{ name, total, … }` keyed by
// repo; for Vercel, a figure keyed by name; for AWS, entries `{ name, period, total, lines, … }` keyed
// by profile; for Neon, entries `{ name, total, … }` keyed by name. Each supplier's `shared` is what
// no name owns: GitHub's entries keyed by account, Vercel's and Neon's one figure; AWS has none. An
// entry with no `total` (can't read, or no good reading yet) has no figure.
const BILLED_BY = { github: 'repos', vercel: 'names', aws: 'profiles', neon: 'names' };
const figure = (e) => (typeof e === 'number' ? e : e?.total);
const named = (r, s) => Object.entries(r[BILLED_BY[s]] ?? {});
const sharedOf = (r) => (typeof r.shared === 'number' ? [r.shared] : Object.values(r.shared ?? {}));
// A reading whose every call failed has a period and no figure: it is not read. Vercel writes its
// totals even then, as 0, so it is read once a team holds lines, from this reading or a kept one;
// AWS once a profile does.
const hasFigure = (r, s) => (s === 'vercel' ? Object.values(r.teams ?? {}).some((t) => t?.lines)
  : s === 'aws' ? Object.values(r.profiles ?? {}).some((p) => p?.lines)
    : [...named(r, s).map(([, e]) => e), ...sharedOf(r)].some((e) => typeof figure(e) === 'number'));
const monthOf = (p) => p.year * 12 + p.month;
const newest = (ps) => ps.reduce((a, p) => (!a || monthOf(p) > monthOf(a) || (monthOf(p) === monthOf(a) && p.to > a.to) ? p : a), null);
// AWS reads each profile on its own day, so its period is its newest profile's with figures.
const periodOf = (r, s) => (s === 'aws' ? newest(Object.values(r.profiles ?? {}).filter((p) => p?.lines && p.period).map((p) => p.period)) : r.period);
// A profile whose last good figures are from another month has no figure this month.
const figureIn = (e, s, period) => (s === 'aws' && !(e?.lines && samePeriod(e.period, period)) ? undefined : figure(e));

// A GitHub item's name on the shared line: "storage", "Actions minutes", else its product.
const githubLabel = (i) => (/storage/i.test(i.sku) ? 'storage' : /minute/i.test(i.unit) ? 'Actions minutes' : i.product || i.sku);
// A Vercel line's name on the shared line: "Pro plan", its seats or service, else its project.
const vercelLabel = (l) => (l.kind === 'plan' ? `${l.label} plan` : l.kind === 'project' ? l.project : l.label);

// Each figure's reading, by name: the time of each source's last good reading and of its last
// failed attempt. Vercel's names are read with their team.
function readsOf(r, s, period) {
  const out = [];
  if (s === 'vercel') {
    for (const t of Object.values(r.teams ?? {})) {
      if (!t?.lines) continue;
      for (const name of new Set(t.lines.filter((l) => l.name != null).map((l) => l.name))) out.push({ name, at: t.at, failedAt: t.failed?.at ?? null });
    }
    return out;
  }
  for (const [key, e] of named(r, s)) if (typeof figureIn(e, s, period) === 'number') out.push({ name: e?.name ?? key, at: e.at, failedAt: e.failed?.at ?? null });
  return out;
}

// What no name owns, line by line: GitHub's items by account, Vercel's lines charged to no name.
function sharedPartsOf(r, s) {
  if (s === 'github') return Object.values(r.shared ?? {}).flatMap((a) => (a?.items ?? []).map((i) => ({ label: githubLabel(i), c: Math.round(i.charged * 100) })));
  if (s === 'vercel') return Object.values(r.teams ?? {}).flatMap((t) => (t?.lines ?? []).filter((l) => l.name == null).map((l) => ({ label: vercelLabel(l), c: Math.round(l.charged * 100) })));
  if (s === 'neon') return (r.sharedLines ?? []).map((l) => ({ label: l.label, c: Math.round(l.charged * 100) }));
  return [];
}

// This month's charges by name, from the newest reading's month: suppliers read for an earlier month
// are left out. Every sum is taken in whole cents, so the lines add up to the total exactly.
// names: every name the cost sources list, so one with no figure still has a row. Each name carries
// what explains its figure: its total by supplier, what AWS credits covered, the GitHub account it
// can't be read from, whether its CI minutes were all discounted in full, and when each supplier's
// figure was read (the oldest source's, with its newest failed attempt).
//   -> { period, total, suppliers: [{ supplier, total }],
//        names: [{ name, total | null, by: { supplier: usd }, credits, cantRead | null, free, freePlan, reads: [{ supplier, at, failedAt }] }],
//        shared | null, sharedParts: [{ supplier, label, total }], credits },
//      most charged first; null with no reading
export function chargesByName({ cache, names = [] }) {
  const read = Object.keys(BILLED_BY).filter((s) => cache?.[s] && periodOf(cache[s], s) && hasFigure(cache[s], s));
  if (!read.length) return null;
  const period = newest(read.map((s) => periodOf(cache[s], s)));
  const by = new Map();
  const row = (name) => {
    if (!by.has(name)) by.set(name, { name, c: null, by: {}, credits: 0, cantRead: null, minutes: 0, freeMinutes: 0, freePlan: false, reads: {} });
    return by.get(name);
  };
  for (const n of names) row(n);
  const suppliers = [];
  const parts = new Map();
  let shared = null;
  for (const s of read.filter((x) => samePeriod(periodOf(cache[x], x), period))) {
    let sum = 0;
    for (const [key, e] of named(cache[s], s)) {
      const n = row(e?.name ?? key);
      if (s === 'github' && e?.cantRead) n.cantRead = { supplier: s, account: e.cantRead.account };
      if (s === 'neon' && e?.cantRead) n.cantRead ??= e.cantRead;
      if (s === 'neon' && e?.free) n.freePlan = true;
      const f = figureIn(e, s, period);
      if (typeof f !== 'number') continue;
      const c = Math.round(f * 100);
      n.c = (n.c ?? 0) + c;
      n.by[s] = (n.by[s] ?? 0) + c;
      sum += c;
      if (s === 'aws') n.credits += (e.lines ?? []).reduce((a, l) => a + Math.round((l.credits ?? 0) * 100), 0);
      for (const i of s === 'github' ? (e.items ?? []).filter((x) => /minute/i.test(x.unit)) : []) { n.minutes++; if (i.discount === 'full') n.freeMinutes++; }
    }
    for (const e of sharedOf(cache[s])) {
      if (typeof figure(e) !== 'number') continue;
      const c = Math.round(figure(e) * 100);
      shared = (shared ?? 0) + c;
      sum += c;
    }
    for (const p of sharedPartsOf(cache[s], s).filter((x) => x.c > 0)) {
      const k = `${s}\u0000${p.label}`;
      parts.set(k, { supplier: s, label: p.label, c: (parts.get(k)?.c ?? 0) + p.c });
    }
    for (const r of readsOf(cache[s], s, period)) {
      const had = row(r.name).reads[s];
      row(r.name).reads[s] = { supplier: s, at: had ? Math.min(had.at, r.at) : r.at, failedAt: Math.max(had?.failedAt ?? 0, r.failedAt ?? 0) || null };
    }
    suppliers.push({ supplier: s, total: sum });
  }
  const total = suppliers.reduce((a, s) => a + s.total, 0);
  const rows = [...by.values()].map((n) => ({ name: n.name, total: n.c == null ? null : n.c / 100,
    by: Object.fromEntries(Object.entries(n.by).map(([s, c]) => [s, c / 100])), credits: n.credits / 100, cantRead: n.cantRead,
    free: n.minutes > 0 && n.freeMinutes === n.minutes, freePlan: n.freePlan, reads: Object.values(n.reads) }))
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.name.localeCompare(b.name));
  return { period, total: total / 100, suppliers: suppliers.map((s) => ({ ...s, total: s.total / 100 })).sort((a, b) => b.total - a.total),
    names: rows, shared: shared == null ? null : shared / 100,
    sharedParts: [...parts.values()].map(({ c, ...p }) => ({ ...p, total: c / 100 })).sort((a, b) => b.total - a.total),
    credits: rows.reduce((a, n) => a + Math.round(n.credits * 100), 0) / 100 };
}

// Each supplier's sources in costs.md.
const sourcesOf = (costs) => ({
  github: costs.entries.filter((e) => e.supplier === 'github'),
  vercel: costs.entries.filter((e) => e.supplier === 'vercel' && e.teamId),
  aws: costs.entries.filter((e) => e.supplier === 'aws'),
  neon: costs.entries.filter((e) => e.supplier === 'neon' && e.orgId),
});

// GitHub and Vercel are due with no reading, failed or not, in the last READ_EVERY_MS. AWS is due
// when any profile is, or when a profile's credit in costs.md differs from the cache's: that alone
// makes no AWS request, since readAws carries a profile that is not due over with costs.md's credit.
const hourly = (sources, had, now) => !(now - (had?.at ?? 0) < READ_EVERY_MS);
const creditMoved = (s, rec) => rec != null && JSON.stringify(rec.credit ?? null) !== JSON.stringify(s.credit ?? null);
const DUE = {
  github: hourly,
  vercel: hourly,
  aws: (sources, had, now) => sources.some((s) => profileDue(had?.profiles?.[s.key], now) || creditMoved(s, had?.profiles?.[s.key]))
    || uncovered(sources, had?.profiles) || sources.some((s) => unidentified(had?.profiles?.[s.key])),
  // Neon is due with no reading for this month, so an org on the free plan still shows, and when any
  // paid org is due as an AWS profile is: Neon reads an org's month at most once a UTC day.
  neon: (sources, had, now) => !samePeriod(had?.period, readingPeriod(now)) || paidOrgs(sources).some((o) => profileDue(had?.orgs?.[o], now)),
};

// The cache as costs.md has it now: a profile removed from costs.md is dropped from AWS, and its
// names recounted, and Neon's use is priced with costs.md's prices, whether or not either has been
// read since.
export function forCosts(cache, costs) {
  if (!costs?.exists) return cache;
  let out = cache;
  if (cache?.neon) out = { ...out, neon: { ...cache.neon, ...neonCharges(cache.neon, sourcesOf(costs).neon) } };
  if (!cache?.aws) return out;
  const keys = new Set(sourcesOf(costs).aws.map((s) => s.key));
  const profiles = Object.fromEntries(Object.entries(cache.aws.profiles ?? {}).filter(([k]) => keys.has(k)));
  if (Object.keys(profiles).length === Object.keys(cache.aws.profiles ?? {}).length) return out;
  return { ...out, aws: { ...cache.aws, profiles, names: awsByName({ profiles }, readingPeriod(cache.aws.at)) } };
}
const NOT_DUE = { github: 'read under an hour ago', vercel: 'read under an hour ago', aws: 'every profile read today, or failed under an hour ago',
  neon: 'every org read today, or failed under an hour ago' };

// The suppliers with sources that are due. Workers running or not makes no difference.
//   -> ['github', 'aws', …]
export function dueSuppliers({ costs = readCosts(E.costsPath()), cache = readCache(), now }) {
  if (!costs.exists) return [];
  return Object.entries(sourcesOf(costs))
    .filter(([s, list]) => list.length && DUE[s](list, cache?.[s], now))
    .map(([s]) => s);
}

const READERS = { github: readGithub, vercel: readVercel, aws: readAws, neon: readNeon };

// Read every due supplier, one at a time per supplier however many callers race: each takes its
// supplier's lock and checks it is still due under it. Another supplier may be read meanwhile, so
// the reading goes into the cache as it is on disk then, under the cache's own lock.
//   -> { github: 'read' | why not, … }
export async function refresh({ dir = costDir(), lockDir = E.lockDir(), costs = readCosts(E.costsPath()), gh = ghApi, vercel = vercelGet, aws = awsCli, neon = neonGet, now = Date.now(), force = false } = {}) {
  const out = {};
  if (!costs.exists) return out;
  for (const [supplier, sources] of Object.entries(sourcesOf(costs))) {
    if (!sources.length) continue;
    const lock = await takeBorrowLock({ dir: lockDir, name: `desk-cost-${supplier}.lock.d`, waitMs: 0 });
    if (!lock.ok) { out[supplier] = 'another reading is running'; continue; }
    try {
      const cache = readCache(dir) ?? { v: 1 };
      if (!force && !dueSuppliers({ costs, cache, now }).includes(supplier)) { out[supplier] = NOT_DUE[supplier]; continue; }
      const read = await READERS[supplier]({ sources, last: cache[supplier] ?? null, gh, vercel, aws, neon, now, force });
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
  else if (cmd === 'show') console.log(JSON.stringify(forCosts(readCache(), readCosts(E.costsPath())), null, 2));
  else { console.error('usage: cost-cache.mjs refresh [--force] | show'); process.exit(2); }
}
