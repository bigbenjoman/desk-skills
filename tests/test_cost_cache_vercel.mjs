// suite: cost cache, Vercel (each team's charges this month, by project with builds apart, and its plan and seats)
// The Vercel reading of the cost cache against fixture JSONL from the charges endpoint
// (GET /v1/billing/charges, one FOCUS charge per day per SKU: BilledCost, ChargePeriodStart,
// ServiceName, Tags.ProjectName), for the three teams voice-pa, pr-ninja and ben-lavenders-projects,
// with a fixed clock (27 October 2026) and a scratch costs.md, auth file, cache dir and lock dir. No
// check calls Vercel: the reader is a function here, and a local HTTP server stands in for the API
// where the real HTTP call is checked. One check or more per criterion of DS-288.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-cost-vercel-'));
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_LOCK_DIR: join(T, 'locks'), DESK_USAGE_DIR: join(T, 'usage'), DESK_COST_DIR: join(T, 'costs'), DESK_COSTS: join(T, 'costs.md'),
  DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills'), DESK_VERCEL_AUTH: join(T, 'auth.json') };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'DESK_VERCEL_API']) delete process.env[k];
Object.assign(process.env, env);
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });

const C = await import(join(BIN, 'cost-cache.mjs'));
const { renderCosts, readCosts } = await import(join(BIN, 'costs.mjs'));

const OCT27 = Date.UTC(2026, 9, 27, 10);
const VOICE_PA = 'team_WgS8cmiltn5LhpHyiyBLNRxm', PR_NINJA = 'team_YoeHAE4DdusnGIPLdmBGVmxh', BEN = 'team_KOo6OJNsSYLcB49QcY3hNJCc';

// ---- fixtures: one JSONL line per charge, its day running 07:00 to 07:00 UTC
const day = (m, d) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T07:00:00.000Z`;
const ch = (service, cost, { project, d = 5, m = 10, category = 'Usage', q = 1, unit = 'units' } = {}) => JSON.stringify({
  BilledCost: cost, BillingCurrency: 'USD', ChargeCategory: category, ChargePeriodStart: day(m, d), ChargePeriodEnd: day(m, d + 1),
  ConsumedQuantity: q, ConsumedUnit: unit, ServiceName: service, ServiceProviderName: 'Vercel',
  Tags: project ? { ProjectId: `prj_${project}`, ProjectName: project } : {} });
const jsonl = (lines) => `${lines.join('\n')}\n`;
const CHARGES = {
  [VOICE_PA]: jsonl([
    ch('Pro Plan', 20, { category: 'Purchase', d: 1 }),
    ch('Additional Seats', 20, { category: 'Purchase', d: 1, q: 1, unit: 'seats' }),
    ch('Build CPU Minutes', 1.2, { project: 'portal', d: 3, q: 120, unit: 'minutes' }),
    ch('Build CPU Minutes', 0.85, { project: 'portal', d: 4, q: 85, unit: 'minutes' }),
    ch('Fast Data Transfer', 0.3, { project: 'portal' }),
    ch('Function Duration', 0.25, { project: 'portal' }),
    ch('Build CPU Minutes', 0.4, { project: 'staging', q: 40, unit: 'minutes' }),
    ch('Edge Requests', 0.02, { project: 'staging' }),
    ch('Build CPU Minutes', 2.13, { project: 'voicepa', q: 213, unit: 'minutes' }),
    ch('Function Invocations', 1.07, { project: 'voicepa' }),
    ch('Fast Data Transfer', 0.6, { project: 'voicepa', d: 26 }),
    // September's last day and today: outside the reading
    ch('Fast Data Transfer', 9.99, { project: 'voicepa', m: 9, d: 30 }),
    ch('Fast Data Transfer', 8.88, { project: 'voicepa', d: 27 }),
  ]),
  [PR_NINJA]: jsonl([
    ch('Pro Plan', 20, { category: 'Purchase', d: 1 }),
    ch('Build CPU Minutes', '0.5', { project: 'pr-ninja', q: 50, unit: 'minutes' }),
    ch('Edge Requests', 0.75, { project: 'pr-ninja' }),
  ]),
  [BEN]: jsonl([
    ch('Pro Plan', 20, { category: 'Purchase', d: 1 }),
    ch('Build CPU Minutes', 0.1, { project: 'desk-site', q: 10, unit: 'minutes' }),
    ch('Fast Data Transfer', 0.33, { project: 'desk-site' }),
    ch('Edge Requests', 0.05, { project: 'tinker' }),
    ch('Function Duration', 1.5, { project: 'old-demo' }),
  ]),
};

const team = (teamId, slug) => ({ supplier: 'vercel', teamId, team: slug, plan: 'pro' });
const sources = [
  ...['portal', 'staging', 'voicepa'].map((p) => ({ ...team(VOICE_PA, 'voice-pa'), key: `voice-pa/${p}`, name: 'voicepa', repo: 'benjo__voicepa', project: p })),
  { ...team(PR_NINJA, 'pr-ninja'), key: 'pr-ninja/pr-ninja', name: 'pr-ninja', repo: 'benjo__pr-ninja', project: 'pr-ninja' },
  { ...team(BEN, 'ben-lavenders-projects'), key: 'ben-lavenders-projects/desk-site', name: 'desk-skills', repo: 'benjo__desk-skills', project: 'desk-site' },
  { ...team(BEN, 'ben-lavenders-projects'), key: 'ben-lavenders-projects/tinker', name: 'tinker', repo: null, project: 'tinker' },
];
writeFileSync(env.DESK_COSTS, renderCosts({ entries: sources, budget: { actionsUsd: null }, logins: { vercel: env.DESK_VERCEL_AUTH } }));
const costs = readCosts(env.DESK_COSTS);
t('fixture costs.md reads back with six Vercel projects on three teams', `${costs.entries.filter((e) => e.supplier === 'vercel').length} ${new Set(costs.entries.map((e) => e.teamId)).size}`, '6 3');

// A fake reader: answers each team's fixture, records each path, and can fail for one team.
const calls = [];
let fail = {};
const param = (path, k) => new URLSearchParams(path.split('?')[1]).get(k);
async function vercel(path) {
  calls.push(path);
  const id = param(path, 'teamId');
  if (fail[id]) throw new Error(fail[id]);
  return CHARGES[id] ?? '';
}
const cache = () => C.readCache();
const line = (tm, pred) => tm?.lines?.find(pred);
const proj = (tm, p) => line(tm, (l) => l.kind === 'project' && l.project === p);
const sum = (ls) => Math.round(ls.reduce((a, l) => a + l.charged, 0) * 100) / 100;

// ---- AC6: due with no reading yet
t('AC6 with no reading yet Vercel is due', C.dueSuppliers({ costs, cache: null, now: OCT27 }).join(), 'vercel');

// ---- AC1: voicepa's charges this month, a line per project with builds apart
t('AC1 the reading runs', (await C.refresh({ costs, vercel, now: OCT27 })).vercel, 'read');
const v = cache().vercel;
const vp = v.teams[VOICE_PA];
t('AC1 one call per team', `${calls.length} ${new Set(calls.map((p) => param(p, 'teamId'))).size}`, '3 3');
t('AC1 against the charges endpoint, from the 1st to the start of today', calls.find((p) => p.includes(VOICE_PA)),
  `/v1/billing/charges?teamId=${VOICE_PA}&from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-27T00%3A00%3A00.000Z`);
t('AC1 voicepa has one line per project: portal, staging, voicepa', vp.lines.filter((l) => l.kind === 'project').map((l) => l.project).join(), 'portal,staging,voicepa');
const portal = proj(vp, 'portal');
t('AC1 portal\'s build charge and its build minutes, apart from its other use', `${portal.build} ${portal.buildQuantity} ${portal.buildUnit} ${portal.other} ${portal.charged}`, '2.05 205 minutes 0.55 2.6');
t('AC1 staging and voicepa the same way', `${proj(vp, 'staging').build}/${proj(vp, 'staging').other} ${proj(vp, 'voicepa').build}/${proj(vp, 'voicepa').other}`, '0.4/0.02 2.13/1.67');
t('AC1 each line is charged to voicepa', vp.lines.every((l) => l.name === 'voicepa'), true);
t('AC1 the time of the reading', `${v.at === OCT27} ${vp.at === OCT27} ${vp.failed}`, 'true true null');
t('AC1 charges from before the 1st or from today are left out', proj(vp, 'voicepa').other, 1.67);
t('AC1 the period is 1 to 26 October', `${v.period.from}..${v.period.to}`, '2026-10-01..2026-10-26');

// ---- AC2: a team one name owns charges its plan, by name, and its seats to that name
const plan = line(vp, (l) => l.kind === 'plan');
t('AC2 voice-pa\'s plan is a line with its name, charged to voicepa', `${plan.label} ${plan.charged} ${plan.name}`, 'Pro 20 voicepa');
const seats = line(vp, (l) => l.kind === 'seats');
t('AC2 its extra seat is a line charged to voicepa', `${seats.label} ${seats.quantity} ${seats.charged} ${seats.name}`, 'Additional Seats 1 20 voicepa');
t('AC2 pr-ninja\'s plan goes to pr-ninja, and a BilledCost given as a string is read', `${line(v.teams[PR_NINJA], (l) => l.kind === 'plan').name} ${proj(v.teams[PR_NINJA], 'pr-ninja').build}`, 'pr-ninja 0.5');

// ---- AC3: a team several names share: each project to its own name, the plan to shared
const ben = v.teams[BEN];
t('AC3 each project goes to its own name', `${proj(ben, 'desk-site').name} ${proj(ben, 'tinker').name}`, 'desk-skills tinker');
const benPlan = line(ben, (l) => l.kind === 'plan');
t('AC3 the team\'s plan, with its name, goes to shared', `${benPlan.label} ${benPlan.charged} ${benPlan.name} ${ben.owner}`, 'Pro 20 null null');

// ---- AC4: a project no name claims goes to shared under its own name
const demo = proj(ben, 'old-demo');
t('AC4 a charge on a project no name claims is kept, under its project name, charged to shared', `${demo?.project} ${demo?.charged} ${demo?.name}`, 'old-demo 1.5 null');

// ---- AC7: a name's lines add up to its Vercel total, to the cent
const linesOf = (n) => Object.values(v.teams).flatMap((tm) => tm.lines).filter((l) => l.name === n);
t('AC7 voicepa\'s lines add up to its total', `${sum(linesOf('voicepa'))} ${v.names.voicepa}`, '46.82 46.82');
t('AC7 and that is every fixture charge in the month for voice-pa', v.names.voicepa, Math.round((20 + 20 + 1.2 + 0.85 + 0.3 + 0.25 + 0.4 + 0.02 + 2.13 + 1.07 + 0.6) * 100) / 100);
t('AC7 pr-ninja, desk-skills and tinker the same', `${v.names['pr-ninja']} ${v.names['desk-skills']} ${v.names.tinker}`, '21.25 0.43 0.05');
t('AC7 shared is the shared team\'s plan and the unclaimed project', `${sum(linesOf(null))} ${v.shared}`, '21.5 21.5');
t('AC7 every team\'s total is its lines', Object.values(v.teams).every((tm) => tm.total === sum(tm.lines)), true);

// ---- AC6: due again only an hour on
t('AC6 under an hour on, nothing is due', C.dueSuppliers({ costs, cache: cache(), now: OCT27 + 59 * 60000 }).length, 0);
t('AC6 over an hour on, Vercel is due', C.dueSuppliers({ costs, cache: cache(), now: OCT27 + 61 * 60000 }).join(), 'vercel');

// ---- AC5: a failed call keeps the last good figures and records the attempt
calls.length = 0;
fail = { [PR_NINJA]: 'timed out after 30s' };
const H2 = OCT27 + 2 * 3600000;
await C.refresh({ costs, vercel, now: H2 });
const v5 = cache().vercel;
t('AC5 the failed team keeps its last good figures and their time', `${v5.teams[PR_NINJA].total} ${v5.teams[PR_NINJA].at === OCT27} ${v5.names['pr-ninja']}`, '21.25 true 21.25');
t('AC5 and records the failed attempt with its time and reason', JSON.stringify(v5.teams[PR_NINJA].failed), JSON.stringify({ at: H2, why: 'timed out after 30s' }));
t('AC5 the other teams still update', `${v5.teams[VOICE_PA].at === H2} ${v5.teams[VOICE_PA].failed}`, 'true null');
t('AC5 the failed attempt counts as a reading: retried after an hour', C.dueSuppliers({ costs, cache: cache(), now: H2 + 30 * 60000 }).length, 0);
fail = {};
const bad = (text) => { try { C.parseCharges(text); return 'read'; } catch (e) { return e.message; } };
t('AC5 a charge not shaped as Vercel documents is a failure, not $0', bad(JSON.stringify({ ServiceName: 'Edge Requests', ChargePeriodStart: day(10, 5) })), 'unexpected response: a charge without BilledCost');
t('AC5 and so is an answer that is not JSONL', bad('<html>sign in</html>'), 'unexpected response: line 1 is not JSON');

// The real HTTP call, against a local server standing in for api.vercel.com: pr-ninja answers 403.
const seen = [];
const server = createServer((req, res) => {
  const id = new URL(req.url, 'http://x').searchParams.get('teamId');
  seen.push(`${req.headers.authorization} ${id}`);
  if (id === PR_NINJA) { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":{"code":"forbidden"}}'); return; }
  res.writeHead(200, { 'content-type': 'application/jsonl' });
  res.end(CHARGES[id] ?? '');
});
await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
process.env.DESK_VERCEL_API = `http://127.0.0.1:${server.address().port}`;
writeFileSync(env.DESK_VERCEL_AUTH, JSON.stringify({ token: 'tok_fixture' }));
const H4 = OCT27 + 4 * 3600000;
await C.refresh({ costs, now: H4 });
const v6 = cache().vercel;
t('AC5 a 403 keeps the team\'s last good figures', `${v6.teams[PR_NINJA].total} ${v6.teams[PR_NINJA].at === OCT27}`, '21.25 true');
t('AC5 and records it with its time and reason', `${v6.teams[PR_NINJA].failed.at === H4} ${v6.teams[PR_NINJA].failed.why}`,
  'true HTTP 403: the Vercel login has expired or cannot read this team\'s billing: run vercel login');
t('AC5 the plain HTTP call sends the CLI\'s token, and the other teams read', `${seen[0].split(' ')[0]} ${seen[0].split(' ')[1]} ${v6.teams[VOICE_PA].at === H4} ${v6.names.voicepa}`, 'Bearer tok_fixture true 46.82');
writeFileSync(env.DESK_VERCEL_AUTH, '{}');
const H6 = OCT27 + 6 * 3600000;
await C.refresh({ costs, now: H6 });
const v7 = cache().vercel;
t('AC5 with no Vercel login, every team keeps its figures and says why', `${v7.teams[VOICE_PA].total} ${v7.teams[VOICE_PA].failed.why}`, '46.82 not signed in to Vercel: run vercel login');
t('AC5 and Vercel is not called', seen.length, 3);
writeFileSync(env.DESK_VERCEL_AUTH, JSON.stringify({ token: 'tok_fixture' }));

// ---- AC6 end to end: desk-q's check starts one background reading and does not wait
const childDir = join(T, 'child-costs');
const childEnv = { ...process.env, DESK_COST_DIR: childDir };
const due = C.dueSuppliers({ costs, cache: null, now: Date.now() });
const t0 = Date.now();
const started = C.startRefresh({ due, env: childEnv });
t('AC6 the check returns at once, the reading left running in the background', `${due.join()} ${started.started} ${Date.now() - t0 < 150} ${existsSync(C.cachePath(childDir))}`, 'vercel true true false');
const until = Date.now() + 15000;
while (Date.now() < until && !C.readCache(childDir)) await new Promise((r) => { setTimeout(r, 100); });
t('AC6 the background reading writes Vercel into the cache', typeof C.readCache(childDir)?.vercel?.at, 'number');
server.close();

console.log(fails ? `${fails} FAILED` : 'all Vercel cost cache checks passed');
process.exit(fails ? 1 : 0);
