// suite: cost cache, AWS (each profile's month by service and record type, read at most once a day)
// The AWS reading against `aws ce get-cost-and-usage` output grouped by SERVICE then RECORD_TYPE:
// forewatt's is a real reply, recorded on 29 October 2026 for 1 to 28 October
// (fixtures/aws-ce-forewatt-2026-10.json, as the CLI printed it); the credit, paging and twin cases
// are built in the same shape. A fixed clock (27 and 28 October, 1 November 2026) and a scratch
// costs.md, cache dir and lock dir. No check calls AWS: aws is a function here that counts its
// calls, and a fake aws script on PATH for the background refresh. One check or more per criterion
// of DS-289.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-cost-aws-'));
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
const OCT27 = utc(10, 27), OCT28 = utc(10, 28), NOV1 = utc(11, 1);

// ---- fixtures: one month, grouped by service then record type
const grp = (service, type, amount) => ({ Keys: [service, type], Metrics: { UnblendedCost: { Amount: String(amount), Unit: 'USD' } } });
const page = (groups, next) => ({ GroupDefinitions: [{ Type: 'DIMENSION', Key: 'SERVICE' }, { Type: 'DIMENSION', Key: 'RECORD_TYPE' }],
  ResultsByTime: [{ TimePeriod: { Start: '2026-10-01', End: '2026-10-27' }, Total: {}, Groups: groups, Estimated: true }],
  DimensionValueAttributes: [], ...(next ? { NextPageToken: next } : {}) });
// The recorded reply comes in name order, so only the sort puts the lines largest first.
const RECORDED = JSON.parse(readFileSync(join(HERE, 'fixtures', 'aws-ce-forewatt-2026-10.json'), 'utf8'));
const FOREWATT = RECORDED.ResultsByTime[0].Groups;
const PRNINJA = [grp('Amazon Elastic Compute Cloud - Compute', 'Usage', '30.3312'), grp('Amazon Elastic Compute Cloud - Compute', 'Credit', '-30.3312'),
  grp('EC2 - Other', 'Usage', '20.17'), grp('EC2 - Other', 'Credit', '-20.17'),
  grp('Amazon Simple Storage Service', 'Usage', '5'), grp('Amazon Simple Storage Service', 'Credit', '-3'),
  grp('Tax', 'Tax', '10.1'), grp('Tax', 'Credit', '-10.1')];
const FANSURGE = [grp('Amazon CloudFront', 'Usage', '0.42')];
const pages = { forewatt: [RECORDED],'prninja-admin': [page(PRNINJA)], fansurge: [page(FANSURGE)] };

const sources = [
  { supplier: 'aws', key: 'forewatt', name: 'forewatt', repo: 'benjo__forewatt', credit: null },
  { supplier: 'aws', key: 'prninja-admin', name: 'pr-ninja', repo: 'benjo__pr-ninja', credit: { usd: 61, ends: '2027-03-31', entered: '2026-10-27' } },
  { supplier: 'aws', key: 'fansurge', name: 'fansurge', repo: null, credit: null },
];
writeFileSync(env.DESK_COSTS, renderCosts({ entries: sources, budget: { actionsUsd: null }, logins: { aws: '~/.aws/config' } }));
const costs = readCosts(env.DESK_COSTS);
t('fixture costs.md reads back with three AWS profiles', costs.entries.filter((e) => e.supplier === 'aws').length, 3);

// A fake aws: answers from the fixtures by profile and page token, records each call, and can fail
// for one profile. Each profile signs in to an account of its own, none of them an organisation's.
const calls = [];
let fail = {};
const arg = (args, flag) => args[args.indexOf(flag) + 1];
const ACCOUNTS = { forewatt: '111111111111', 'prninja-admin': '757324725511', fansurge: '222222222222' };
const DENIED = 'An error occurred (AccessDeniedException) when calling the ListAccounts operation';
async function aws(args) {
  calls.push(args);
  const p = arg(args, '--profile');
  if (fail[p]) throw new Error(fail[p]);
  if (args[0] === 'sts') return { UserId: 'AROA:desk', Account: ACCOUNTS[p], Arn: `arn:aws:sts::${ACCOUNTS[p]}:assumed-role/admin/desk` };
  if (args[0] === 'organizations') throw new Error(DENIED);
  const token = args.includes('--next-page-token') ? Number(arg(args, '--next-page-token')) : 0;
  return pages[p][token];
}
const reset = () => { calls.length = 0; fail = {}; };
const ce = () => calls.filter((a) => a[0] === 'ce');
const of = (p) => ce().filter((a) => arg(a, '--profile') === p).length;
const cache = () => C.readCache();
const line = (r, s) => r?.lines?.find((l) => l.service === s);
const sum = (lines) => Math.round(lines.reduce((a, l) => a + l.charged, 0) * 100) / 100;

// ---- AC1, AC2, AC3, AC6, AC7, AC8: the first reading, on 27 October
t('AC9 with no reading yet AWS is due', C.dueSuppliers({ costs, cache: null, now: OCT27 }).join(), 'aws');
t('AC1 the reading runs', (await C.refresh({ costs, aws, now: OCT27 })).aws, 'read');
const a = cache().aws;
const fw = a.profiles.forewatt;
t('AC1 forewatt\'s lines, one per service, largest first, tax last', fw.lines.map((l) => l.service).join(' | '),
  'Amazon Relational Database Service | Amazon Elastic Container Service | AmazonCloudWatch | Amazon Virtual Private Cloud | AWS Step Functions'
  + ' | Amazon Simple Storage Service | Amazon EC2 Container Registry (ECR) | AWS Secrets Manager | AWS Cost Explorer | Amazon API Gateway'
  + ' | AWS Key Management Service | Tax');
t('AC1 each charged to the cent', fw.lines.map((l) => l.charged).join(' '), '59.9 19.54 12.62 5.94 3.24 1.89 0.44 0.36 0.04 0.01 0.01 20.79');
t('AC1 tax is a line of its own, marked as tax', `${line(fw, 'Tax').charged} ${line(fw, 'Tax').tax}`, '20.79 true');
t('AC1 a tax record under another service joins the tax line', JSON.stringify(C.awsLines([{ service: 'Amazon Route 53', type: 'Tax', amount: 0.2 }, { service: 'Tax', type: 'Tax', amount: 0.69 }])),
  '[{"service":"Tax","used":0.89,"credits":0,"charged":0.89,"tax":true}]');
t('AC1 a line under a cent in every figure is left out, and so is one at $0', `${!!line(fw, 'Amazon DynamoDB')} ${!!line(fw, 'AWS Glue')}`, 'false false');
t('AC1 with the profile it was read with and the time of the reading', `${fw.profile} ${fw.name} ${fw.at === OCT27} ${fw.failed}`, 'forewatt forewatt true null');
t('AC1 for 1 to 26 October, days in UTC', `${fw.period.from}..${fw.period.to}`, '2026-10-01..2026-10-26');
t('AC1 asked of Cost Explorer as the ticket gives it, End exclusive', ce().find((c) => arg(c, '--profile') === 'forewatt').join(' '),
  'ce get-cost-and-usage --profile forewatt --time-period Start=2026-10-01,End=2026-10-27 --granularity MONTHLY --metrics UnblendedCost '
  + '--group-by Type=DIMENSION,Key=SERVICE Type=DIMENSION,Key=RECORD_TYPE --output json --no-paginate');
const pn = a.profiles['prninja-admin'];
const ec2 = line(pn, 'Amazon Elastic Compute Cloud - Compute');
t('AC2 a service credits cover in full: used, credits, and $0.00 charged', `${ec2.used} ${ec2.credits} ${ec2.charged}`, '30.33 30.33 0');
t('AC2 a service credits cover in part is charged the rest', ((l) => `${l.used} ${l.credits} ${l.charged}`)(line(pn, 'Amazon Simple Storage Service')), '5 3 2');
t('AC2 credited tax is a tax line charged $0.00', ((l) => `${l.used} ${l.credits} ${l.charged} ${l.tax}`)(line(pn, 'Tax')), '10.1 10.1 0 true');
t('AC2 the profile\'s total is what was charged', pn.total, 2);
const fs = a.profiles.fansurge;
t('AC3 a profile with no repo in desk is kept under its own name', `${fs.name} ${fs.repo} ${fs.total}`, 'fansurge null 0.42');
t('AC3 and stands as a name of its own in the cache', `${Object.keys(a.names).sort().join()} ${a.names.fansurge.repo} ${a.names.fansurge.total}`, 'fansurge,forewatt,pr-ninja null 0.42');
t('AC6 one Cost Explorer request per profile', ['forewatt', 'prninja-admin', 'fansurge'].map(of).join(), '1,1,1');
// The recorded amounts add up to 124.77 raw; its lines, each to the cent, to 124.78.
t('AC7 forewatt\'s lines add up to its total to the cent', `${sum(fw.lines)} ${fw.total}`, '124.78 124.78');
// Two profiles under one name, each service a third of a cent over: the rounded lines add to 1.32
// where the raw amounts would round to 1.34.
const third = (...services) => [page(services.map((s) => grp(s, 'Usage', '0.334')))];
const twins = await C.readAws({ sources: [{ supplier: 'aws', key: 'twin-a', name: 'twin', repo: null, credit: null }, { supplier: 'aws', key: 'twin-b', name: 'twin', repo: null, credit: null }],
  aws: async (args) => ({ 'twin-a': third('Amazon Simple Storage Service', 'AWS Lambda'), 'twin-b': third('Amazon Simple Storage Service', 'Amazon CloudFront') })[arg(args, '--profile')][0], now: OCT27 });
const twin = twins.names.twin;
t('AC7 a name\'s profiles merge into one line per service', `${twin.profiles.join()} ${twin.lines.map((l) => `${l.service} ${l.charged}`).join(' | ')}`,
  'twin-a,twin-b Amazon Simple Storage Service 0.66 | AWS Lambda 0.33 | Amazon CloudFront 0.33');
t('AC7 and the name\'s total is its lines added up, not its raw amounts', twin.total, 1.32);
// On 2 November twin-b's login has expired and it still holds October: November's total for the
// name is twin-a's alone, and twin-b is named as left out.
const NOV2 = utc(11, 2);
const lateTwins = await C.readAws({ sources: [{ supplier: 'aws', key: 'twin-a', name: 'twin', repo: null, credit: null }, { supplier: 'aws', key: 'twin-b', name: 'twin', repo: null, credit: null }],
  last: twins, aws: async (args) => { if (arg(args, '--profile') === 'twin-b') throw new Error('Token has expired'); return third('AWS Lambda')[0]; }, now: NOV2 });
const late = lateTwins.names.twin;
t('AC7 a profile still holding last month is left out of the name\'s total', `${late.period.month} ${late.total} ${late.lines.map((l) => l.service).join()}`, '11 0.33 AWS Lambda');
t('AC7 and named as stale and failed', `${late.stale.join()} ${late.failed.join()} ${lateTwins.profiles['twin-b'].period.month}`, 'twin-b twin-b 10');
t('AC8 the profile\'s saved credit comes with its figures', JSON.stringify(pn.credit), '{"usd":61,"ends":"2027-03-31","entered":"2026-10-27"}');
t('AC8 a profile with none saved has none', fw.credit, null);

// ---- AC4: read earlier the same day, no AWS request is made
reset();
t('AC4 later the same day nothing is due', C.dueSuppliers({ costs, cache: cache(), now: OCT27 + 12 * 3600000 }).length, 0);
t('AC4 and a refresh says so', (await C.refresh({ costs, aws, now: OCT27 + 12 * 3600000 })).aws, 'every profile read today, or failed under an hour ago');
t('AC4 with no AWS request', calls.length, 0);
const topUp = { usd: 120, ends: '2027-06-30', entered: '2026-10-27' };
const topped = { ...costs, entries: costs.entries.map((e) => (e.key === 'prninja-admin' ? { ...e, credit: topUp } : e)) };
t('AC8 a credit saved later the same day is due', C.dueSuppliers({ costs: topped, cache: cache(), now: OCT27 + 13 * 3600000 }).join(), 'aws');
t('AC8 and reaches the cache with no AWS request', `${(await C.refresh({ costs: topped, aws, now: OCT27 + 13 * 3600000 })).aws} ${calls.length} ${JSON.stringify(cache().aws.profiles['prninja-admin'].credit)} ${cache().aws.profiles['prninja-admin'].total}`,
  `read 0 ${JSON.stringify(topUp)} 2`);
t('AC8 with the cache as costs.md has it, nothing is due', C.dueSuppliers({ costs: topped, cache: cache(), now: OCT27 + 13 * 3600000 }).length, 0);
await C.refresh({ costs, aws, now: OCT27 + 13 * 3600000 });
t('AC8 putting the credit back costs no AWS request either', `${calls.length} ${cache().aws.profiles['prninja-admin'].credit?.usd}`, '0 61');
t('AC4 the next UTC day it is due again', C.dueSuppliers({ costs, cache: cache(), now: utc(10, 28, 0) }).join(), 'aws');

// ---- AC5: a failed call or an expired login keeps the last good figures, retried no sooner than an hour on
reset();
const EXPIRED = 'Error when retrieving token from sso: Token has expired and refresh failed';
fail = { 'prninja-admin': EXPIRED };
FOREWATT.push(grp('Amazon Simple Email Service', 'Usage', '0.1'));
await C.refresh({ costs, aws, now: OCT28 });
const a5 = cache().aws;
t('AC5 the failed profile keeps its last good figures and their time', `${a5.profiles['prninja-admin'].total} ${a5.profiles['prninja-admin'].at === OCT27} ${a5.profiles['prninja-admin'].lines.length}`, '2 true 4');
t('AC5 and records the failed attempt with its time and reason', JSON.stringify(a5.profiles['prninja-admin'].failed), JSON.stringify({ at: OCT28, why: EXPIRED }));
t('AC5 the other profiles still update', `${a5.profiles.forewatt.total} ${a5.profiles.forewatt.at === OCT28}`, '124.88 true');
reset();
await C.refresh({ costs, aws, now: OCT28 + 59 * 60000 });
t('AC5 under an hour on, the failed profile is not tried again', of('prninja-admin'), 0);
await C.refresh({ costs, aws, now: OCT28 + 61 * 60000 });
t('AC5 an hour on it is, and only it', `${of('prninja-admin')} ${of('forewatt')} ${of('fansurge')}`, '1 0 0');
t('AC5 and once read, its failure is cleared', `${cache().aws.profiles['prninja-admin'].failed} ${cache().aws.profiles['prninja-admin'].at === OCT28 + 61 * 60000}`, 'null true');
const neverRead = await C.readAws({ sources: [sources[2]], last: null, aws: async () => { throw new Error('An error occurred (AccessDeniedException)'); }, now: OCT28 });
t('AC5 a profile that never read has only its failure', JSON.stringify(neverRead.profiles.fansurge.failed), JSON.stringify({ at: OCT28, why: 'An error occurred (AccessDeniedException)' }));
t('AC5 a response not shaped as AWS documents is a failure, not $0', (() => { try { C.parseCostAndUsage(page([{ Keys: ['AWS Lambda', 'Usage'], Metrics: {} }])); return 'read'; } catch (e) { return e.message; } })(),
  'unexpected response: a group without an UnblendedCost amount');
t('AC5 and so is a cost in another currency', (() => { try { C.parseCostAndUsage(page([{ Keys: ['AWS Lambda', 'Usage'], Metrics: { UnblendedCost: { Amount: '3', Unit: 'EUR' } } }])); return 'read'; } catch (e) { return e.message; } })(),
  'unexpected response: a cost in EUR, not USD');

// ---- AC6: a second page is a second request, and never a third
reset();
pages.fansurge = [page(FANSURGE, '1'), page([grp('Amazon CloudFront', 'Tax', '0.08')])];
const two = await C.readAws({ sources: [sources[2]], last: null, aws, now: OCT28 });
t('AC6 a second page is read with its token', `${ce().length} ${arg(ce()[1], '--next-page-token')} ${two.profiles.fansurge.total}`, '2 1 0.5');
reset();
pages.fansurge = [page(FANSURGE, '1'), page(FANSURGE, '2'), page(FANSURGE)];
const three = await C.readAws({ sources: [sources[2]], last: null, aws, now: OCT28 });
t('AC6 a third page is never asked for: the reading fails after two requests', `${ce().length} ${three.profiles.fansurge.failed?.why}`, '2 more than 2 pages of results');

// ---- AC10: 1 November reads October in full
reset();
pages.fansurge = [page(FANSURGE)];
await C.refresh({ costs, aws, now: NOV1 });
const a10 = cache().aws;
t('AC10 every profile is due on 1 November', `${of('forewatt')} ${of('prninja-admin')} ${of('fansurge')}`, '1 1 1');
t('AC10 and asks for 1 October to 1 November, End exclusive', ce().every((c) => arg(c, '--time-period') === 'Start=2026-10-01,End=2026-11-01'), true);
t('AC10 the cache gives it as October, 1–31', `${a10.profiles.forewatt.period.month} ${a10.profiles.forewatt.period.from}..${a10.profiles.forewatt.period.to}`, '10 2026-10-01..2026-10-31');

// ---- a GitHub reading that ends after an AWS one does not undo it, nor send AWS again
reset();
const BOTH = join(T, 'both.md');
writeFileSync(BOTH, renderCosts({ entries: [{ supplier: 'github', key: 'benjo/voicepa', name: 'voicepa', repo: 'benjo__voicepa', account: 'benjo', readable: true }, ...sources],
  budget: { actionsUsd: null }, logins: { aws: '~/.aws/config' } }));
const both = readCosts(BOTH);
const raceDir = join(T, 'race-costs');
let open;
const gate = new Promise((r) => { open = r; });
const slowGh = async () => { await gate; throw new Error('gh: offline'); };
const ghFirst = C.refresh({ dir: raceDir, costs: both, gh: slowGh, aws, now: NOV1 });
await new Promise((r) => { setTimeout(r, 50); });
const awsMeanwhile = await C.refresh({ dir: raceDir, costs: both, gh: slowGh, aws, now: NOV1 });
open();
const ghLater = await ghFirst;
t('race: the second refresh reads AWS while the first holds GitHub', `${both.entries.length} ${awsMeanwhile.github} | ${awsMeanwhile.aws}`, '4 another reading is running | read');
t('race: the first then writes GitHub and finds AWS already read', `${ghLater.github} | ${ghLater.aws}`, 'read | every profile read today, or failed under an hour ago');
t('race: both readings are in the cache', `${!!C.readCache(raceDir).github?.repos?.['benjo/voicepa']} ${C.readCache(raceDir).aws?.profiles?.forewatt?.total}`, 'true 124.88');
t('race: one Cost Explorer request per profile', ['forewatt', 'prninja-admin', 'fansurge'].map(of).join(), '1,1,1');

// ---- DS-325: each AWS account counted once per name
// voicepa's shape: default and voicepa-admin both sign in to the management account 070870781760,
// whose figures hold its linked account 748214039541, which voicepa-ci signs in to.
const VP_ACCOUNTS = { default: '070870781760', 'voicepa-admin': '070870781760', 'voicepa-ci': '748214039541' };
const VP_ORG = { '070870781760': ['070870781760', '748214039541'] };
const VP_CE = { '070870781760': [grp('Amazon Simple Storage Service', 'Usage', '4.52'), grp('AWS Lambda', 'Usage', '1.2')],
  '748214039541': [grp('AWS Lambda', 'Usage', '1.2')] };
const vcalls = [];
async function vpAws(args) {
  vcalls.push(args);
  const id = VP_ACCOUNTS[arg(args, '--profile')];
  if (args[0] === 'sts') return { UserId: 'AROA:desk', Account: id, Arn: `arn:aws:sts::${id}:assumed-role/admin/desk` };
  if (args[0] === 'organizations') {
    if (!VP_ORG[id]) throw new Error(DENIED);
    return { Accounts: VP_ORG[id].map((Id) => ({ Id, Status: 'ACTIVE' })) };
  }
  return page(VP_CE[id]);
}
const vp = (key) => ({ supplier: 'aws', key, name: 'voicepa', repo: 'benjo__voicepa', credit: null });
const vpCe = (p) => vcalls.filter((a) => a[0] === 'ce' && arg(a, '--profile') === p).length;

const same = await C.readAws({ sources: [vp('default'), vp('voicepa-admin')], aws: vpAws, now: OCT28 });
t('DS-325 AC1 two profiles on one account: the name counts it once', `${same.names.voicepa.total} ${same.names.voicepa.lines.map((l) => `${l.service} ${l.charged}`).join(' | ')}`,
  '5.72 Amazon Simple Storage Service 4.52 | AWS Lambda 1.2');
t('DS-325 AC1 and the second profile is reported as covered by the first', `${JSON.stringify(same.names.voicepa.covered)} ${same.profiles['voicepa-admin'].covered} ${same.profiles['voicepa-admin'].total}`,
  '[{"profile":"voicepa-admin","by":"default"}] default undefined');
t('DS-325 AC1 each profile\'s account is recorded', `${same.profiles.default.account} ${same.profiles['voicepa-admin'].account} ${same.profiles.default.linked.join()}`,
  '070870781760 070870781760 748214039541');

vcalls.length = 0;
const org = await C.readAws({ sources: [vp('voicepa-ci'), vp('default')], aws: vpAws, now: OCT28 });
t('DS-325 AC2 a linked account counts once, in its organisation\'s figures', `${org.names.voicepa.total} ${org.profiles.default.total}`, '5.72 5.72');
t('DS-325 AC2 the linked profile is covered by the organisation\'s, listed first or not', org.profiles['voicepa-ci'].covered, 'default');
t('DS-325 AC2 and makes no Cost Explorer request', `${vpCe('voicepa-ci')} ${vpCe('default')}`, '0 1');

const VP = join(T, 'voicepa.md');
const vpCosts = (keys) => {
  writeFileSync(VP, renderCosts({ entries: keys.map(vp), budget: { actionsUsd: null }, logins: { aws: '~/.aws/config' } }));
  return readCosts(VP);
};
const vpDir = join(T, 'vp-costs');
vcalls.length = 0;
await C.refresh({ dir: vpDir, costs: vpCosts(['default', 'voicepa-admin', 'voicepa-ci']), aws: vpAws, now: OCT28 });
const vpRead = C.readCache(vpDir);
t('DS-325 all three of the 29 October profiles: the name is one organisation\'s figures, read once', `${vpRead.aws.names.voicepa.total} ${vcalls.filter((a) => a[0] === 'ce').length}`, '5.72 1');
const all = vpCosts(['default', 'voicepa-admin', 'voicepa-ci']);
t('DS-325 and the Costs tab charges it once', C.chargesByName({ cache: C.forCosts(vpRead, all), names: ['voicepa'] }).names[0].total, 5.72);
// A fourth profile, on an account of its own, read earlier and since removed from costs.md.
const withGone = { ...vpRead, aws: { ...vpRead.aws, profiles: { ...vpRead.aws.profiles,
  gone: { ...vpRead.aws.profiles.default, profile: 'gone', account: '333333333333', linked: [] } } } };
t('DS-325 AC3 a profile removed from costs.md, on a day AWS is not due', C.dueSuppliers({ costs: all, cache: withGone, now: OCT28 + 3600000 }).length, 0);
t('DS-325 AC3 is in no total when the cache is read', C.chargesByName({ cache: C.forCosts(withGone, all), names: ['voicepa'] }).names[0].total, 5.72);
t('DS-325 AC3 nor when it is shown', `${Object.keys(C.forCosts(withGone, all).aws.profiles).join()} ${C.forCosts(withGone, all).aws.names.voicepa.total}`,
  'default,voicepa-admin,voicepa-ci 5.72');
const dropped = vpCosts(['voicepa-admin', 'voicepa-ci']);
t('DS-325 AC3 removing the profile that covered the rest makes AWS due the same day', C.dueSuppliers({ costs: dropped, cache: vpRead, now: OCT28 + 3600000 }).join(), 'aws');
vcalls.length = 0;
await C.refresh({ dir: vpDir, costs: dropped, aws: vpAws, now: OCT28 + 3600000 });
const after = C.readCache(vpDir).aws;
t('DS-325 AC3 and the profile that takes over is read, the rest still covered', `${after.names.voicepa.total} ${vpCe('voicepa-admin')} ${vpCe('voicepa-ci')} ${after.profiles['voicepa-ci'].covered} ${Object.keys(after.profiles).join()}`,
  '5.72 1 0 voicepa-admin voicepa-admin,voicepa-ci');

const plain = await C.readAws({ sources, aws: async (args) => { if (args[0] !== 'ce') throw new Error(DENIED); return pages[arg(args, '--profile')][0]; }, now: OCT28 });
const counted = await C.readAws({ sources, aws, now: OCT28 });
t('DS-325 AC4 one profile per account: the totals are as they were', Object.keys(counted.names).map((n) => `${n} ${counted.names[n].total}`).join(),
  Object.keys(plain.names).map((n) => `${n} ${plain.names[n].total}`).join());
t('DS-325 AC4 and nothing is covered', Object.values(counted.names).flatMap((n) => n.covered).length, 0);

// ---- AC9: desk-q's check starts one background reading per profile and does not wait
mkdirSync(join(T, 'bin'));
const fakeAws = join(T, 'bin', 'aws');
const awsLog = join(T, 'aws-calls');
writeFileSync(join(T, 'answer.json'), JSON.stringify(RECORDED));
writeFileSync(fakeAws, `#!/bin/sh\necho "attempts=$AWS_MAX_ATTEMPTS $*" >> "${awsLog}"\nsleep 0.2\ncat "${join(T, 'answer.json')}"\n`);
chmodSync(fakeAws, 0o755);
// The child runs on the real clock, so it gets a cache of its own.
const childDir = join(T, 'child-costs');
const childEnv = { ...process.env, DESK_COST_DIR: childDir, PATH: `${join(T, 'bin')}:${process.env.PATH}` };
const due = C.dueSuppliers({ costs, cache: null, now: Date.now() });
const t0 = Date.now();
const started = [C.startRefresh({ due, env: childEnv }), C.startRefresh({ due, env: childEnv })];
t('AC9 the check returns at once, the reading left running in the background', `${started.every((s) => s.started)} ${Date.now() - t0 < 150} ${existsSync(C.cachePath(childDir))}`, 'true true false');
const until = Date.now() + 15000;
while (Date.now() < until && !C.readCache(childDir)) await new Promise((r) => { setTimeout(r, 100); });
await new Promise((r) => { setTimeout(r, 1500); });
const awsCalls = () => (existsSync(awsLog) ? readFileSync(awsLog, 'utf8').trim().split('\n') : []);
t('AC9 the background reading writes the cache', C.readCache(childDir)?.aws?.profiles?.forewatt?.total, 124.88);
t('AC9 two started together make one request per profile', ['forewatt', 'prninja-admin', 'fansurge'].map((p) => awsCalls().filter((l) => l.includes(` ce get-cost-and-usage --profile ${p} `)).length).join(), '1,1,1');
t('AC6 each aws call runs with the CLI\'s retries off, so one call is one request', awsCalls().length > 0 && awsCalls().every((l) => l.startsWith('attempts=1 ')), true);
t('AC9 with that reading made today, the next check starts nothing', C.startRefresh({ due: C.dueSuppliers({ costs, cache: C.readCache(childDir), now: Date.now() }), env: childEnv }).started, false);

console.log(fails ? `${fails} FAILED` : 'all AWS cost cache checks passed');
process.exit(fails ? 1 : 0);
