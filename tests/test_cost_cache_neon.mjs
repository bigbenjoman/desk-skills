// suite: cost cache, Neon (each org's use this month, priced from costs.md, per repo)
// The Neon reading of the cost cache against Neon's own documented example reply for
// GET /consumption_history/v2/projects (tests/fixtures/neon, from the docs, not a live account), for
// three orgs: org-voice (one name), org-shared (two names, read in pages) and org-free (the free plan),
// with a fixed clock (6 February 2026, the fixture's month) and a scratch costs.md, key file, cache
// dir and lock dir. No check calls Neon: the reader is a function here, and a local HTTP server stands
// in for the API where the real HTTP call is checked. One check or more per criterion of DS-343.
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-cost-neon-'));
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_LOCK_DIR: join(T, 'locks'), DESK_USAGE_DIR: join(T, 'usage'), DESK_COST_DIR: join(T, 'costs'), DESK_COSTS: join(T, 'costs.md'),
  DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills'), DESK_NEON_KEY: join(T, 'neon-api-key') };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'DESK_NEON_API', 'COLORFGBG', 'COLORTERM', 'NO_COLOR']) delete process.env[k];
Object.assign(process.env, env);
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
writeFileSync(env.DESK_NEON_KEY, 'napi_fixture\n');

const C = await import(join(BIN, 'cost-cache.mjs'));
const { renderCosts, readCosts } = await import(join(BIN, 'costs.mjs'));
const Q = await import(join(BIN, 'desk-q.mjs'));

const FEB6 = Date.UTC(2026, 1, 6, 10);
const DOCS = JSON.parse(readFileSync(join(HERE, 'fixtures', 'neon', 'consumption-history-v2-projects.docs.json'), 'utf8'));
const DAWN = DOCS.projects[0].project_id;
// The documented project under another id, and a project whose only use is two CU-hours: the rest
// of its metrics are zero, so left out of the reply.
const as = (id) => ({ ...structuredClone(DOCS.projects[0]), project_id: id });
const computeOnly = (id) => ({ project_id: id, periods: [{ period_id: 'p', period_plan: 'scale', period_start: '2026-02-01T00:00:00Z',
  consumption: [{ timeframe_start: '2026-02-03T00:00:00Z', timeframe_end: '2026-02-04T00:00:00Z', metrics: [{ metric_name: 'compute_unit_seconds', value: 7200 }] }] }] });
// Each org's reply, page by page: a page's cursor names the next.
const PAGES = {
  'org-voice': [DOCS, { projects: [], pagination: { cursor: DAWN } }],
  'org-shared': [{ projects: [as('p-fw')], pagination: { cursor: 'p-fw' } }, { projects: [computeOnly('p-tk'), as('p-other')], pagination: { cursor: 'p-other' } },
    { projects: [], pagination: { cursor: 'p-other' } }],
};
const PRICES = { compute: 0.14, storage: 0.35, restore: 0.2, snapshots: 0.09, transfer: 0.1, branches: 1.5 };
const neonRow = (name, orgId, plan, fee, project, repo = null) => ({ supplier: 'neon', key: `${orgId}/${project}`, name, repo, orgId, plan, fee, prices: PRICES, project });
const sources = [
  neonRow('voicepa', 'org-voice', 'launch', 5, DAWN, 'benjo__voicepa'),
  neonRow('forewatt', 'org-shared', 'scale', 10, 'p-fw', 'benjo__forewatt'),
  neonRow('tinker', 'org-shared', 'scale', 10, 'p-tk'),
  neonRow('hobby', 'org-free', 'free', null, 'p-hobby'),
  { supplier: 'github', key: 'benjo/voicepa', name: 'voicepa', repo: 'benjo__voicepa', account: 'benjo', readable: true },
];
writeFileSync(env.DESK_COSTS, renderCosts({ entries: sources, budget: { actionsUsd: null }, logins: { neon: env.DESK_NEON_KEY } }));
const costs = readCosts(env.DESK_COSTS);
const neonEntries = costs.entries.filter((e) => e.supplier === 'neon');
t('costs.md\'s Neon section reads back: four projects on three orgs', `${neonEntries.length} ${new Set(neonEntries.map((e) => e.orgId)).size}`, '4 3');
t('and each row keeps its plan, fee and prices', JSON.stringify(neonEntries.find((e) => e.name === 'voicepa')), JSON.stringify({ supplier: 'neon', key: `org-voice/${DAWN}`,
  name: 'voicepa', repo: 'benjo__voicepa', orgId: 'org-voice', plan: 'launch', fee: 5, prices: PRICES, project: DAWN }));

// A fake reader: answers each org's pages by cursor, records each path and key, and can fail.
const calls = [];
let fail = null;
const param = (path, k) => new URLSearchParams(path.split('?')[1]).get(k);
async function neon(path, key) {
  calls.push({ path, key });
  if (fail) throw fail;
  const pages = PAGES[param(path, 'org_id')] ?? [{ projects: [], pagination: {} }];
  const cursor = param(path, 'cursor');
  return pages[cursor == null ? 0 : pages.findIndex((p) => p.pagination?.cursor === cursor) + 1] ?? { projects: [], pagination: {} };
}
// GitHub is read beside Neon, with nothing charged: it must never reach the real gh.
const gh = async () => ({ usageItems: [] });
const cache = () => C.readCache();
const charges = () => C.chargesByName({ cache: C.forCosts(cache(), costs), names: ['voicepa', 'forewatt', 'tinker', 'hobby'] });
const nameOf = (c, n) => c.names.find((x) => x.name === n);
const orgsCalled = () => calls.map((c) => param(c.path, 'org_id'));

// ---- AC1: one consumption query per paid org, daily from the 1st, every billed metric, paged
t('AC1 with no reading yet Neon is due', C.dueSuppliers({ costs, cache: null, now: FEB6 }).join(), 'github,neon');
const ran = await C.refresh({ costs, neon, gh, now: FEB6 });
t('AC1 the reading runs', ran.neon, 'read');
const first = calls.find((c) => param(c.path, 'org_id') === 'org-voice').path;
t('AC1 against the v2 projects endpoint', first.split('?')[0], '/consumption_history/v2/projects');
t('AC1 daily, from the 1st to the start of today', `${param(first, 'granularity')} ${param(first, 'from')} ${param(first, 'to')}`, 'daily 2026-02-01T00:00:00.000Z 2026-02-06T00:00:00.000Z');
t('AC1 for the org, with the seven metrics', `${param(first, 'org_id')} ${param(first, 'metrics')}`,
  'org-voice compute_unit_seconds,root_branch_bytes_month,child_branch_bytes_month,instant_restore_bytes_month,snapshot_storage_bytes_month,public_network_transfer_bytes,extra_branches_month');
t('AC1 with the key from the key file', calls.every((c) => c.key === 'napi_fixture'), true);
t('AC1 paging with cursor until a page has no projects', calls.map((c) => `${param(c.path, 'org_id')}:${param(c.path, 'cursor') ?? '-'}`).join(' '),
  `org-shared:- org-shared:p-fw org-shared:p-other org-voice:- org-voice:${DAWN}`);
const n1 = cache().neon;
t('AC1 cached with its time and period, as AWS and Vercel are', `${n1.at === FEB6} ${n1.period.from}..${n1.period.to} ${n1.orgs['org-voice'].at === FEB6} ${n1.orgs['org-voice'].failed}`,
  'true 2026-02-01..2026-02-05 true null');
t('AC1 each day\'s use is added up, a missing metric as 0', JSON.stringify(n1.orgs['org-voice'].usage[DAWN]), JSON.stringify({ compute_unit_seconds: 320,
  root_branch_bytes_month: 1517125632, instant_restore_bytes_month: 1081832, snapshot_storage_bytes_month: 0, public_network_transfer_bytes: 3598 }));
t('AC1 read again later the same UTC day: not due', C.dueSuppliers({ costs, cache: cache(), now: FEB6 + 6 * 3600000 }).includes('neon'), false);
t('AC1 the next UTC day: due', C.dueSuppliers({ costs, cache: cache(), now: FEB6 + 18 * 3600000 }).includes('neon'), true);
t('AC1 an org not due is not read, even when refresh runs', (await C.refresh({ costs, neon, gh, now: FEB6 + 3600000 })).neon, 'every org read today, or failed under an hour ago');

// ---- AC2: use in billing units times the prices, plus the plan's fee, in the repo's total
// 320 CU-seconds at $0.14 a CU-hour, 1.517 GB-months at $0.35, 0.00108 GB-months of restore at $0.20
// and 3598 bytes out: 54 cents, and the $5 fee.
const c2 = charges();
t('AC2 voicepa\'s Neon charge is its use priced, plus its org\'s fee', nameOf(c2, 'voicepa').by.neon, 5.54);
t('AC2 and it is in voicepa\'s total, beside GitHub', `${nameOf(c2, 'voicepa').total} ${JSON.stringify(nameOf(c2, 'voicepa').by)}`, '5.54 {"github":0,"neon":5.54}');
t('AC2 Neon is a supplier in the month\'s total: every name\'s and the shared fee', c2.suppliers.find((s) => s.supplier === 'neon')?.total, 16.36);
const priced = C.forCosts(cache(), { ...costs, entries: costs.entries.map((e) => (e.name === 'voicepa' && e.supplier === 'neon' ? { ...e, fee: 0, prices: { ...PRICES, storage: 0.7 } } : e)) });
t('AC2 priced from costs.md as shown: a new price needs no new reading', priced.neon.names.voicepa.total, 1.07);
const sup = Q.supplierScreen([], 'voicepa', { now: FEB6, costs, cache: cache(), pinUsage: true }).split('\n');
t('AC2 the repo\'s supplier view has a Neon row', sup.find((l) => l.startsWith('  Neon')), `  ${'Neon'.padEnd(10)}${'Postgres'.padEnd(24)}${'$5.54'.padStart(11)}`);

// ---- AC3: an org on the free plan makes no call and shows $0 with a free plan tag
t('AC3 org-free is never called', orgsCalled().includes('org-free'), false);
t('AC3 hobby shows Neon at $0, on the free plan', `${nameOf(c2, 'hobby').total} ${nameOf(c2, 'hobby').by.neon} ${nameOf(c2, 'hobby').freePlan}`, '0 0 true');
const hob = Q.supplierScreen([], 'hobby', { now: FEB6, costs, cache: cache(), pinUsage: true }).split('\n');
t('AC3 its supplier view tags Neon "free plan"', hob.find((l) => l.startsWith('  Neon')), `  ${'Neon'.padEnd(10)}${'Postgres'.padEnd(24)}${'$0.00'.padStart(11)}  free plan`);
const freeOnly = { ...costs, entries: costs.entries.filter((e) => e.name === 'hobby') };
const hobLater = Q.supplierScreen([], 'hobby', { now: FEB6 + 2 * 24 * 3600000, costs: freeOnly, cache: cache(), pinUsage: true }).split('\n');
t('AC3 days later, with nothing read since, still "free plan": a free org is never read, so never stale', hobLater.find((l) => l.startsWith('  Neon')),
  `  ${'Neon'.padEnd(10)}${'Postgres'.padEnd(24)}${'$0.00'.padStart(11)}  free plan`);
t('AC3 with only free orgs Neon is due once a month, and makes no call', `${C.dueSuppliers({ costs: freeOnly, cache: null, now: FEB6 }).join()} ${C.dueSuppliers({ costs: freeOnly, cache: cache(), now: FEB6 + 18 * 3600000 }).join()}`, 'neon ');

// ---- AC5: one org shared by two repos is read once, each charged only its own projects
t('AC5 org-shared is read once: one pass over its pages', orgsCalled().filter((o) => o === 'org-shared').length, 3);
t('AC5 forewatt is charged only p-fw, the documented use priced', nameOf(c2, 'forewatt').by.neon, 0.54);
t('AC5 tinker only p-tk: two CU-hours', nameOf(c2, 'tinker').by.neon, 0.28);
t('AC5 a project no name lists is charged to nobody', JSON.stringify(Object.keys(n1.orgs['org-shared'].usage)), JSON.stringify(['p-fw', 'p-tk', 'p-other']));
t('AC5 the fee of an org two names share goes to shared', `${c2.shared} ${JSON.stringify(c2.sharedParts)}`, '10 [{"supplier":"neon","label":"Scale plan","total":10}]');

// ---- AC4: a missing or refused key shows "can't read" naming the key file; other suppliers still show
const D1 = FEB6 + 24 * 3600000;
writeFileSync(env.DESK_NEON_KEY, '');
calls.length = 0;
await C.refresh({ costs, neon, gh, now: D1 });
t('AC4 with no key, Neon is not called', calls.length, 0);
const c4 = charges();
t('AC4 voicepa\'s Neon reads can\'t read, naming the key file', JSON.stringify(nameOf(c4, 'voicepa').cantRead), JSON.stringify({ supplier: 'neon', text: `can't read: no Neon API key in ${env.DESK_NEON_KEY}` }));
t('AC4 and its GitHub figure still shows', nameOf(c4, 'voicepa').by.github, 0);
const sup4 = Q.supplierScreen([], 'voicepa', { now: D1, costs, cache: cache(), pinUsage: true }).split('\n');
t('AC4 the supplier view tags the Neon row', sup4.find((l) => l.startsWith('  Neon')),
  `  ${'Neon'.padEnd(10)}${'Postgres'.padEnd(24)}${'–'.padStart(11)}  ◌ can't read: no Neon API key in ${env.DESK_NEON_KEY}`);
t('AC4 a free org needs no key', nameOf(c4, 'hobby').by.neon, 0);
writeFileSync(env.DESK_NEON_KEY, 'napi_fixture');
fail = Object.assign(new Error('HTTP 401: Neon refused the API key'), { refused: true });
const D1b = D1 + 2 * 3600000;
await C.refresh({ costs, neon, gh, now: D1b });
t('AC4 a refused key reads can\'t read too', nameOf(charges(), 'voicepa').cantRead?.text, `can't read: Neon refused the API key in ${env.DESK_NEON_KEY}`);
t('AC4 the attempt is kept with its time and reason', `${cache().neon.orgs['org-voice'].failed.at === D1b} ${cache().neon.orgs['org-voice'].failed.why}`, 'true HTTP 401: Neon refused the API key');
fail = new Error('timed out after 30s');
await C.refresh({ costs, neon, gh, now: D1b + 2 * 3600000 });
const n4 = cache().neon.orgs['org-voice'];
t('AC4 any other failure keeps the last good use and says why', `${n4.at === FEB6} ${n4.cantRead} ${n4.failed.why} ${nameOf(charges(), 'voicepa').by.neon}`, 'true null timed out after 30s 5.54');
fail = null;

// ---- a reply not shaped as Neon documents is a failure, not $0
const bad = (body) => { try { C.parseConsumption(body); return 'read'; } catch (e) { return e.message; } };
t('a reply with no projects list is refused', bad({ error: 'x' }), 'unexpected response: no projects');
t('a metric without a value is refused', bad({ projects: [{ project_id: 'p', periods: [{ consumption: [{ metrics: [{ metric_name: 'compute_unit_seconds' }] }] }] }] }),
  'unexpected response: a metric without a name and value');
t('the documented reply reads', bad(DOCS), 'read');
const unpriced = C.neonCharges(cache().neon, neonEntries.map((e) => (e.name === 'tinker' ? { ...e, prices: { storage: 0.35 } } : e)));
t('use with no price in costs.md gives no figure and says which', `${unpriced.names.tinker.total} ${unpriced.names.tinker.cantRead.text}`, 'undefined can\'t price: no Neon price for compute in costs.md');

// ---- the real HTTP call, against a local server standing in for console.neon.tech: org-shared answers 403
const seen = [];
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  seen.push(`${req.headers.authorization} ${u.pathname} ${u.searchParams.get('org_id')}`);
  if (u.searchParams.get('org_id') === 'org-shared') { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"message":"forbidden"}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(u.searchParams.get('cursor') ? { projects: [], pagination: {} } : DOCS));
});
await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
process.env.DESK_NEON_API = `http://127.0.0.1:${server.address().port}/api/v2`;
const D2 = FEB6 + 2 * 24 * 3600000;
await C.refresh({ costs, gh, now: D2 });
server.close();
t('the plain HTTP call sends the key as a bearer token, to the v2 path', seen.find((s) => s.endsWith('org-voice')), 'Bearer napi_fixture /api/v2/consumption_history/v2/projects org-voice');
t('and reads the documented reply', cache().neon.orgs['org-voice'].usage[DAWN].compute_unit_seconds, 320);
t('a 403 is a refused key', `${cache().neon.orgs['org-shared'].cantRead} ${nameOf(charges(), 'forewatt').cantRead?.text}`, `refused can't read: Neon refused the API key in ${env.DESK_NEON_KEY}`);

console.log(fails ? `${fails} FAILED` : 'all Neon cost cache checks passed');
process.exit(fails ? 1 : 0);
