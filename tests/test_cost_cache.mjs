// suite: cost cache (GitHub's month summary per repo, the shared line, and the refresh desk-q starts)
// The cost cache against fixture month summary responses (the usageItems shape GitHub documents for
// GET /users/{username}/settings/billing/usage/summary), a fixed clock (27 October, 1 and 2 November
// 2026) and a scratch costs.md, cache dir and lock dir. No check calls GitHub: gh is a function here,
// and a fake gh script on PATH for the background refresh. One check or more per criterion of DS-287.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-cost-cache-'));
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_LOCK_DIR: join(T, 'locks'), DESK_USAGE_DIR: join(T, 'usage'), DESK_COST_DIR: join(T, 'costs'), DESK_COSTS: join(T, 'costs.md'),
  DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills') };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG']) delete process.env[k];
Object.assign(process.env, env);
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });

const C = await import(join(BIN, 'cost-cache.mjs'));
const { renderCosts, readCosts } = await import(join(BIN, 'costs.mjs'));

const utc = (m, d, h = 10) => Date.UTC(2026, m - 1, d, h);
const OCT27 = utc(10, 27), NOV1 = utc(11, 1), NOV2 = utc(11, 2);

// ---- fixtures
const item = (sku, unit, grossQ, gross, discount, product = 'Actions') => ({ product, sku, unitType: unit, pricePerUnit: grossQ ? gross / grossQ : 0,
  grossQuantity: grossQ, grossAmount: gross, discountQuantity: gross ? grossQ * (discount / gross) : 0, discountAmount: discount,
  netQuantity: gross ? grossQ * (1 - discount / gross) : grossQ, netAmount: gross - discount });
const body = (items, repository) => ({ timePeriod: { year: 2026 }, user: 'benjo', ...(repository ? { repository } : {}), usageItems: items });
const VOICEPA = [item('actions_linux', 'minutes', 1200, 9.6, 0), item('actions_macos', 'minutes', 30, 1.86, 0)];
const PRNINJA = [item('actions_linux', 'minutes', 500, 4, 4)];
const ACCOUNT = [item('actions_linux', 'minutes', 1700, 13.6, 4), item('actions_macos', 'minutes', 30, 1.86, 0),
  item('actions_storage', 'gigabyte-hours', 900, 0.21, 0)];
const LAST = { 'benjo/voicepa': [item('actions_linux', 'minutes', 900, 7.2, 0)], 'benjo/pr-ninja': [item('actions_linux', 'minutes', 100, 0.8, 0.8)] };

const sources = [
  { supplier: 'github', key: 'benjo/voicepa', name: 'voicepa', repo: 'benjo__voicepa', account: 'benjo', readable: true },
  { supplier: 'github', key: 'benjo/pr-ninja', name: 'pr-ninja', repo: 'benjo__pr-ninja', account: 'benjo', readable: true },
  { supplier: 'github', key: 'acme-co/site', name: 'site', repo: null, account: 'acme-co', readable: false },
];
writeFileSync(env.DESK_COSTS, renderCosts({ entries: sources, budget: { actionsUsd: null }, logins: { github: 'gh' } }));
const costs = readCosts(env.DESK_COSTS);
t('fixture costs.md reads back with three GitHub sources', costs.entries.filter((e) => e.supplier === 'github').length, 3);

// A fake gh: answers from the fixtures by month and repository, records each path, and can fail,
// hang or be slow for one repository.
const calls = [];
let fail = {}, slowMs = 0;
const param = (path, k) => new URLSearchParams(path.split('?')[1]).get(k);
async function gh(path) {
  calls.push(path);
  const repo = param(path, 'repository');
  if (slowMs) await new Promise((r) => { setTimeout(r, slowMs); });
  if (fail[repo ?? 'account']) throw new Error(fail[repo ?? 'account']);
  if (param(path, 'month') === '9') return body(LAST[repo] ?? [], repo);
  if (!repo) return body(ACCOUNT);
  return body({ 'benjo/voicepa': VOICEPA, 'benjo/pr-ninja': PRNINJA }[repo] ?? [], repo);
}
const reset = () => { calls.length = 0; fail = {}; slowMs = 0; };
const cache = () => C.readCache();
const sku = (r, s) => r?.items?.find((i) => i.sku === s);

// ---- AC10: no cost sources, nothing runs and nothing is written
const none = readCosts(join(T, 'missing.md'));
t('AC10 no costs.md: nothing is due', C.dueSuppliers({ costs: none, cache: null, now: OCT27 }).length, 0);
t('AC10 and a refresh reads nothing', JSON.stringify(await C.refresh({ costs: none, gh, now: OCT27 })), '{}');
t('AC10 no call is made and no cache is written', `${calls.length} ${existsSync(C.cachePath())}`, '0 false');
t('AC10 the check desk-q runs starts nothing', C.startRefresh({ now: OCT27, due: C.dueSuppliers({ costs: none, now: OCT27 }) }).started, false);

// ---- AC1 to AC4, AC9, AC12: the first reading, on 27 October
t('AC6 with no reading yet GitHub is due', C.dueSuppliers({ costs, cache: null, now: OCT27 }).join(), 'github');
t('AC1 the reading runs', (await C.refresh({ costs, gh, now: OCT27 })).github, 'read');
const g = cache().github;
const vp = g.repos['benjo/voicepa'];
t('AC1 voicepa\'s Linux minutes and what GitHub charged for them', `${sku(vp, 'actions_linux').quantity} ${sku(vp, 'actions_linux').charged}`, '1200 9.6');
t('AC1 and its macOS minutes, a runner type of its own', `${sku(vp, 'actions_macos').quantity} ${sku(vp, 'actions_macos').charged}`, '30 1.86');
t('AC1 voicepa\'s total and the time of the reading', `${vp.total} ${vp.at === OCT27}`, '11.46 true');
t('AC1 one call per repo for the month, with the repository named', calls.filter((p) => p.includes('month=10&repository=benjo/voicepa')).length, 1);
t('AC1 against the month summary endpoint', calls.includes('/users/benjo/settings/billing/usage/summary?year=2026&month=10&repository=benjo/voicepa'), true);
const pn = g.repos['benjo/pr-ninja'];
t('AC2 a public repo\'s fully discounted minutes are charged $0.00, never their list price', `${sku(pn, 'actions_linux').quantity} ${sku(pn, 'actions_linux').charged} ${pn.total}`, '500 0 0');
t('AC2 and are marked discounted in full', sku(pn, 'actions_linux').discount, 'full');
t('AC2 minutes charged in full are not marked', sku(vp, 'actions_linux').discount, 'none');
const sh = g.shared.benjo;
t('AC3 storage no repo owns is a shared line', `${sku(sh, 'actions_storage')?.quantity} ${sku(sh, 'actions_storage')?.charged} ${sh.total}`, '900 0.21 0.21');
t('AC3 minutes every repo accounts for leave nothing shared', sh.items.map((i) => i.sku).join(), 'actions_storage');
t('AC3 read with one account call, no repository', calls.filter((p) => !p.includes('repository=') && p.includes('month=10')).length, 1);
t('AC4 a repo on another account is never called', calls.some((p) => p.includes('acme-co')), false);
t('AC4 and is marked can\'t read with the account it bills to', JSON.stringify(g.repos['acme-co/site']), '{"name":"site","cantRead":{"account":"acme-co"}}');
t('AC9 the cache says the figures cover 1 to 26 October, days in UTC', `${g.period.from}..${g.period.to}`, '2026-10-01..2026-10-26');
t('AC9 a reading just after midnight UTC still covers to yesterday', C.readingPeriod(Date.UTC(2026, 9, 27, 0, 5)).to, '2026-10-26');
t('AC12 with no last month in the cache, the first reading also reads September', calls.filter((p) => p.includes('month=9&')).length, 2);
t('AC12 and keeps its charged total per repo', `${g.lastMonth.period.month} ${g.lastMonth.repos['benjo/voicepa'].total} ${g.lastMonth.repos['benjo/pr-ninja'].total}`, '9 7.2 0');

// ---- AC6: due again only an hour on, whatever workers do
t('AC6 under an hour on, nothing is due', C.dueSuppliers({ costs, cache: cache(), now: OCT27 + 59 * 60000 }).length, 0);
t('AC6 and a refresh then reads nothing', (await C.refresh({ costs, gh, now: OCT27 + 59 * 60000 })).github, 'read under an hour ago');
t('AC6 over an hour on, GitHub is due', C.dueSuppliers({ costs, cache: cache(), now: OCT27 + 61 * 60000 }).join(), 'github');

// ---- AC5: a failed or timed-out call keeps the last good figures, and the others update
reset();
fail = { 'benjo/voicepa': 'timed out after 30s' };
VOICEPA[0] = item('actions_linux', 'minutes', 1300, 10.4, 0);
PRNINJA.push(item('actions_windows', 'minutes', 10, 0.16, 0));
const H2 = OCT27 + 2 * 3600000;
await C.refresh({ costs, gh, now: H2 });
const g5 = cache().github;
t('AC5 the failed repo keeps its last good figures and their time', `${g5.repos['benjo/voicepa'].total} ${g5.repos['benjo/voicepa'].at === OCT27}`, '11.46 true');
t('AC5 and records the failed attempt with its time and reason', JSON.stringify(g5.repos['benjo/voicepa'].failed), JSON.stringify({ at: H2, why: 'timed out after 30s' }));
t('AC5 other repos\' figures still update', `${g5.repos['benjo/pr-ninja'].total} ${g5.repos['benjo/pr-ninja'].at === H2} ${g5.repos['benjo/pr-ninja'].failed}`, '0.16 true null');
t('AC5 the shared line keeps its last figures rather than counting voicepa\'s minutes as shared', `${g5.shared.benjo.total} ${!!g5.shared.benjo.failed}`, '0.21 true');
t('AC5 the failed attempt counts as a reading: retried after an hour', C.dueSuppliers({ costs, cache: cache(), now: H2 + 30 * 60000 }).length, 0);
t('AC12 last month is read once: never again once kept', calls.filter((p) => p.includes('month=9&')).length, 0);
reset();
fail = { account: 'HTTP 502: Bad Gateway' };
await C.refresh({ costs, gh, now: H2 + 2 * 3600000 });
const g5b = cache().github;
t('AC5 with the account call failing, voicepa now updates and the shared line keeps its figures', `${g5b.repos['benjo/voicepa'].total} ${g5b.shared.benjo.total} ${g5b.shared.benjo.failed.why}`, '12.26 0.21 HTTP 502: Bad Gateway');
reset();
t('AC5 a response not shaped as GitHub documents is a failure, not $0', (() => { try { C.parseSummary({ usageItems: [{ sku: 'actions_linux', grossQuantity: 5 }] }); return 'read'; } catch (e) { return e.message; } })(),
  'unexpected response: a usage item without grossAmount');

// ---- AC7: two windows reaching a due reading together start one
reset();
slowMs = 30;
const R7 = OCT27 + 6 * 3600000;
const both = await Promise.all([C.refresh({ costs, gh, now: R7 }), C.refresh({ costs, gh, now: R7 })]);
t('AC7 two at once: one reads', both.map((r) => r.github).sort().join(' | '), 'another reading is running | read');
t('AC7 so each repo is called once', calls.filter((p) => p.includes('repository=benjo/voicepa')).length, 1);
t('AC7 and the one that waited finds it read under the lock', (await C.refresh({ costs, gh, now: R7 + 1000 })).github, 'read under an hour ago');

// ---- AC8: 1 November reads October in full; November's first reading is on 2 November
reset();
t('AC8 on 1 November the period is October, 1–31', (({ month, from, to }) => `${month} ${from}..${to}`)(C.readingPeriod(NOV1)), '10 2026-10-01..2026-10-31');
await C.refresh({ costs, gh, now: NOV1 });
const g8 = cache().github;
t('AC8 the reading asks GitHub for October', calls.filter((p) => p.includes('repository=')).every((p) => p.includes('month=10&')), true);
t('AC8 and the cache gives it as October, 1–31', `${g8.period.month} ${g8.period.from}..${g8.period.to}`, '10 2026-10-01..2026-10-31');
t('AC8 November\'s first reading is on 2 November', (({ month, from, to }) => `${month} ${from}..${to}`)(C.readingPeriod(NOV2)), '11 2026-11-01..2026-11-01');

// ---- AC11: this month's first reading keeps last month's charged total per repo
reset();
await C.refresh({ costs, gh, now: NOV2 });
const g11 = cache().github;
t('AC11 November\'s first reading keeps October\'s charged total per repo', `${g11.period.month} ${g11.lastMonth.period.month} ${g11.lastMonth.repos['benjo/voicepa'].total} ${g11.lastMonth.repos['benjo/pr-ninja'].total}`, '11 10 12.26 0.16');
t('AC11 carried from the cache, with no call for October', calls.filter((p) => p.includes('month=10')).length, 0);
t('AC11 a repo that cannot be read has no total to keep', g11.lastMonth.repos['acme-co/site'], undefined);
// A month last read part-way is not a month's total: it is read again in full.
const part = { ...g8, period: { ...g8.period, to: '2026-10-30' }, lastMonth: null };
reset();
const gp = await C.readGithub({ sources: costs.entries, last: part, gh, now: NOV2 });
t('AC11 October read only to the 30th is read again in full rather than carried', `${calls.filter((p) => p.includes('month=10&')).length} ${gp.lastMonth.repos['benjo/voicepa'].total}`, '2 12.26');
// A repo whose 1 November call failed holds figures from part of October: it is read again, not carried.
const stale = { ...g8, repos: { ...g8.repos, 'benjo/voicepa': { ...g8.repos['benjo/voicepa'], total: 5, failed: { at: NOV1, why: 'timed out after 30s' } } }, lastMonth: null };
reset();
const gs = await C.readGithub({ sources: costs.entries, last: stale, gh, now: NOV2 });
t('AC11 a repo whose last October call failed is read again for October rather than carried', `${calls.filter((p) => p.includes('month=10&')).join()} ${gs.lastMonth.repos['benjo/voicepa'].total} ${gs.lastMonth.repos['benjo/pr-ninja'].total}`,
  '/users/benjo/settings/billing/usage/summary?year=2026&month=10&repository=benjo/voicepa 12.26 0.16');

// ---- AC6 and AC7 end to end: desk-q's check starts one background reading and does not wait
mkdirSync(join(T, 'bin'));
const fakeGh = join(T, 'bin', 'gh');
writeFileSync(join(T, 'answer.json'), JSON.stringify(body(VOICEPA)));
writeFileSync(fakeGh, `#!/bin/sh\necho "$*" >> "${join(T, 'gh-calls')}"\nsleep 0.2\ncat "${join(T, 'answer.json')}"\n`);
chmodSync(fakeGh, 0o755);
// The child runs on the real clock, so it gets a cache of its own.
const childDir = join(T, 'child-costs');
const childEnv = { ...process.env, DESK_COST_DIR: childDir, PATH: `${join(T, 'bin')}:${process.env.PATH}` };
const due = C.dueSuppliers({ costs, cache: null, now: Date.now() });
const t0 = Date.now();
const started = [C.startRefresh({ due, env: childEnv }), C.startRefresh({ due, env: childEnv })];
t('AC6 the check returns at once, the reading left running in the background', `${started.every((s) => s.started)} ${Date.now() - t0 < 150} ${existsSync(C.cachePath(childDir))}`, 'true true false');
const until = Date.now() + 15000;
while (Date.now() < until && !C.readCache(childDir)) await new Promise((r) => { setTimeout(r, 100); });
await new Promise((r) => { setTimeout(r, 1500); });
const ghCalls = existsSync(join(T, 'gh-calls')) ? readFileSync(join(T, 'gh-calls'), 'utf8').trim().split('\n') : [];
t('AC6 the background reading writes the cache', C.readCache(childDir)?.github?.repos?.['benjo/voicepa']?.total, 12.26);
const vpCalls = ghCalls.filter((l) => l.includes('repository=benjo/voicepa'));
t('AC7 two started together read each repo once a month: this month and last', `${vpCalls.length} ${new Set(vpCalls).size}`, '2 2');

// ---- AC6: desk-q's open screen runs the check on its timer, workers running or not
const Q = await import(join(BIN, 'desk-q.mjs'));
const { PassThrough } = await import('node:stream');
const slug = 'acme__busy';
mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'), '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `3100` |\n');
const qp = join(env.DESK_HOME, 'repos', slug, 'queue.json');
mkdirSync(dirname(qp), { recursive: true });
writeFileSync(qp, JSON.stringify({ version: 1, batch: 'busy', concurrency: 2, tickets: { 'B-1': { key: 'B-1', state: 'running' } } }));
const input = new PassThrough();
Object.assign(input, { isTTY: true, setRawMode() {} });
const output = { buf: '', columns: 200, rows: 40, write(s) { this.buf += s; }, on() {}, removeListener() {} };
const checks = [];
const later = NOV2 + 3 * 3600000;
const ui = Q.interactive({ input, output, start: { kind: 'overview', all: false }, exit() {}, refreshMs: 600000, clock: () => later,
  probeMs: 20, probeWith: async () => ({ ran: false }), costWith: (o) => { checks.push(o.now); return { started: false }; } });
await new Promise((r) => { setTimeout(r, 120); });
ui.finish(0);
t('AC6 with a worker running, the open screen still runs the cost check', checks.length > 0, true);

console.log(fails ? `${fails} FAILED` : 'all cost cache checks passed');
process.exit(fails ? 1 : 0);
