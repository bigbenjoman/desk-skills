// suite: cost sources (desk-env costs detect, propose, write, show)
// Cost sources: the AWS config and Vercel parsers on fixture output, the proposal that matches
// sources to names, the costs.md file, and the desk-env costs CLI against a fake gh, a local stand-in
// for the Vercel API and a scratch AWS config. Scratch directories only; nothing reads this computer.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAwsConfig, parseVercelTeams, parseVercelProjects, matchName, propose, parseEdits,
  renderCosts, parseCosts, readCosts, costsByName,
} from '../desk/bin/costs.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');

// ---- fixtures: the Mac mini as measured, with the shapes the AWS config and the Vercel API use
const AWS = `[default]
region = eu-west-2

[profile voicepa-admin]
sso_session = ben
sso_account_id = 111111111111

[profile prninja-admin]
region = eu-west-2
[profile forewatt]
[profile yieldindex]
[profile fansurge]
[sso-session ben]
sso_start_url = https://example.awsapps.com/start
`;
const team = (id, slug, name, plan) => ({ id, slug, name, avatar: null, createdAt: 1700000000000, membership: { role: 'OWNER', confirmed: true }, billing: { plan } });
const TEAMS = { teams: [
  team('team_vpa', 'voice-pa', 'Voice PA', 'pro'),
  team('team_prn', 'pr-ninja', 'PR Ninja', 'pro'),
  team('team_blp', 'ben-lavenders-projects', "Ben Lavender's projects", 'hobby'),
  { slug: 'no-id' },
], pagination: { count: 4, next: null, prev: null } };
const project = (name) => ({ id: `prj_${name}`, name, accountId: 'x', framework: 'nextjs', updatedAt: 1700000000000 });
const PROJECTS = {
  team_vpa: [{ projects: [project('voicepa-web'), project('voicepa-admin')], pagination: { count: 2, next: 1699999999999, prev: null } },
    { projects: [project('voicepa-docs')], pagination: { count: 1, next: null, prev: null } }],
  team_prn: [{ projects: [project('pr-ninja')], pagination: { count: 1, next: null, prev: null } }],
  team_blp: [{ projects: [project('forewatt'), project('yield-index'), project('gygg-platform')], pagination: { count: 3, next: null, prev: null } }],
};
const REPOS = [
  { slug: 'bigbenjoman__voicepa', ghRepo: 'bigbenjoman/voicepa' },
  { slug: 'bigbenjoman__pr-ninja', ghRepo: 'bigbenjoman/pr-ninja' },
  { slug: 'bigbenjoman__forewatt', ghRepo: 'bigbenjoman/forewatt' },
  { slug: 'bigbenjoman__yield-index', ghRepo: 'bigbenjoman/yield-index' },
  { slug: 'bigbenjoman__gygg-platform', ghRepo: 'bigbenjoman/gygg-platform' },
  { slug: 'pranichealinguk__pranicuk', ghRepo: 'pranichealinguk/pranicuk' },
];

// ---- parsers
t('aws: default and every profile, no sso-session', parseAwsConfig(AWS).join(), 'default,voicepa-admin,prninja-admin,forewatt,yieldindex,fansurge');
t('aws: no config reads as no profiles', parseAwsConfig(null).length, 0);
const pt = parseVercelTeams(TEAMS);
t('vercel teams: id, slug and plan', pt.teams.map((x) => `${x.id}:${x.slug}:${x.plan}`).join(), 'team_vpa:voice-pa:pro,team_prn:pr-ninja:pro,team_blp:ben-lavenders-projects:hobby');
t('vercel teams: one without an id is skipped, not guessed', pt.skipped, 1);
t('vercel teams: no billing reads as unknown', parseVercelTeams({ teams: [{ id: 'a', slug: 'b' }] }).teams[0].plan, 'unknown');
t('vercel teams: a body with no teams is none', parseVercelTeams({ error: { code: 'forbidden' } }).teams.length, 0);
const pp = parseVercelProjects(PROJECTS.team_vpa[0]);
t('vercel projects: names and the next page', `${pp.projects.join()} ${pp.next}`, 'voicepa-web,voicepa-admin 1699999999999');

// ---- names
const names = ['voicepa', 'pr-ninja', 'forewatt', 'yield-index', 'gygg-platform', 'pranicuk'];
t('match: a profile with a role suffix', matchName('prninja-admin', names), 'pr-ninja');
t('match: a team slug with a hyphen', matchName('voice-pa', names), 'voicepa');
t('match: a profile without the hyphen', matchName('yieldindex', names), 'yield-index');
t('match: nothing for a name with no repo', matchName('fansurge', names), null);
t('match: the longest name wins', matchName('pr-ninja-pro', ['pr-ninja', 'pr-ninja-pro']), 'pr-ninja-pro');

// ---- the proposal (AC1, AC3, AC4, AC5)
const withProjects = pt.teams.map((x) => ({ ...x, projects: PROJECTS[x.id].flatMap((p) => p.projects.map((q) => q.name)) }));
const found = { repos: REPOS, login: 'bigbenjoman', vercel: { auth: '/a/auth.json', teams: withProjects, error: null }, aws: { path: '/a/config', profiles: parseAwsConfig(AWS), error: null } };
const TODAY = '2026-10-27';
const p1 = propose({ found, saved: null, today: TODAY });
const one = (p, id) => p.entries.find((e) => `${e.supplier}:${e.key}` === id);
t('AC1 every repo proposed against its name', one(p1, 'github:bigbenjoman/voicepa').name, 'voicepa');
t('AC1 a team that matches a name takes its projects', ['voice-pa/voicepa-web', 'voice-pa/voicepa-docs'].map((k) => one(p1, `vercel:${k}`).name).join(), 'voicepa,voicepa');
t('AC1 an AWS profile against its repo', `${one(p1, 'aws:voicepa-admin').name} ${one(p1, 'aws:prninja-admin').name} ${one(p1, 'aws:yieldindex').name}`, 'voicepa pr-ninja yield-index');
t('AC1 every source is new', p1.entries.every((e) => e.status === 'new'), true);
t('AC3 an unmatched profile gets its own name', one(p1, 'aws:fansurge').name, 'fansurge');
t('AC3 and no repo', one(p1, 'aws:fansurge').repo, null);
t('AC4 each project of a mixed team under its own name', ['forewatt', 'yield-index', 'gygg-platform'].map((k) => one(p1, `vercel:ben-lavenders-projects/${k}`).name).join(), 'forewatt,yield-index,gygg-platform');
t('AC4 and against its repo', one(p1, 'vercel:ben-lavenders-projects/gygg-platform').repo, 'bigbenjoman__gygg-platform');
t('AC5 a repo in another account: that account', one(p1, 'github:pranichealinguk/pranicuk').account, 'pranichealinguk');
t('AC5 and not readable', one(p1, 'github:pranichealinguk/pranicuk').readable, false);
t('AC5 a repo in the signed-in account is readable', one(p1, 'github:bigbenjoman/voicepa').readable, true);
t('gh signed out: readable unknown', one(propose({ found: { ...found, login: null }, saved: null, today: TODAY }), 'github:bigbenjoman/voicepa').readable, null);

// ---- edits (AC3, AC6, AC7)
const e1 = parseEdits(['--name', 'aws:default=voicepa', '--drop', 'vercel:voice-pa/voicepa-docs', '--actions-budget', '$40', '--credit', 'fansurge=1200.50@2027-03-31']);
const p2 = propose({ found, saved: null, edits: e1, today: TODAY });
t('edit: a source renamed takes that name and its repo', `${one(p2, 'aws:default').name} ${one(p2, 'aws:default').repo}`, 'voicepa bigbenjoman__voicepa');
t('edit: a dropped source is gone', one(p2, 'vercel:voice-pa/voicepa-docs'), undefined);
t('AC6 the actions budget in dollars', p2.budget.actionsUsd, 40);
t('AC7 a credit with its end and the day entered', JSON.stringify(one(p2, 'aws:fansurge').credit), '{"usd":1200.5,"ends":"2027-03-31","entered":"2026-10-27"}');
const threw = (f) => { try { f(); return 'no error'; } catch (e) { return e.message; } };
t('edit: an unknown source is refused', /no source aws:nope/.test(threw(() => propose({ found, saved: null, edits: parseEdits(['--name', 'aws:nope=x']), today: TODAY }))), true);
t('edit: a credit with no date is refused', /--credit wants/.test(threw(() => parseEdits(['--credit', 'fansurge=1200']))), true);
t('edit: an unknown option is refused', /unknown option/.test(threw(() => parseEdits(['--budget', '1']))), true);

// ---- the file (AC2, AC4, AC10)
const text = renderCosts(p2);
const back = parseCosts(text);
t('round trip: every source comes back', back.entries.length, p2.entries.length);
t('round trip: the same names', back.entries.map((e) => `${e.supplier}:${e.key}=${e.name}`).sort().join(), p2.entries.map((e) => `${e.supplier}:${e.key}=${e.name}`).sort().join());
t('AC2 a vercel row keeps the team id, slug and plan', /\| `forewatt` \| `bigbenjoman__forewatt` \| `team_blp` \| `ben-lavenders-projects` \| `hobby` \| `yes` \| `forewatt` \|/.test(text), true);
t('AC4 a team with one name is not shared', /\| `voicepa` \| `bigbenjoman__voicepa` \| `team_vpa` \| `voice-pa` \| `pro` \| `no` \| `voicepa-admin, voicepa-web` \|/.test(text), true);
t('AC3 a name with no repo is written as none', /\| `fansurge` \| `none` \| `fansurge` \| `1200.5` \| `2027-03-31` \| `2026-10-27` \|/.test(text), true);
t('no token anywhere: logins say where', /\| `vercel` \| `\/a\/auth.json` \|/.test(text), true);
const by = costsByName(back);
t('AC10 each name as data: vercel', JSON.stringify(by['yield-index'].vercel), '[{"teamId":"team_blp","team":"ben-lavenders-projects","plan":"hobby","shared":true,"projects":["yield-index"]}]');
t('AC10 each name as data: github', JSON.stringify(by.pranicuk.github), '[{"repo":"pranichealinguk/pranicuk","account":"pranichealinguk","readable":false}]');
t('AC10 each name as data: aws credit', by.fansurge.aws[0].credit.ends, '2027-03-31');
t('AC10 the budget', back.budget.actionsUsd, 40);
const missing = readCosts('/nonexistent/costs.md');
t('AC10 a missing file is no cost sources, not an error', `${missing.exists} ${missing.entries.length} ${missing.budget.actionsUsd}`, 'false 0 null');

// ---- a re-run (AC8)
const morePa = { ...found, aws: { ...found.aws, profiles: [...found.aws.profiles, 'newco-admin'] } };
const p3 = propose({ found: morePa, saved: back, today: '2026-11-01' });
t('AC8 saved sources keep their names', one(p3, 'aws:default').name, 'voicepa');
t('AC8 saved sources read as saved', one(p3, 'aws:default').status, 'saved');
t('AC8 a new profile is proposed', `${one(p3, 'aws:newco-admin').name} ${one(p3, 'aws:newco-admin').status}`, 'newco new');
t('AC8 a saved credit is kept', one(p3, 'aws:fansurge').credit.entered, '2026-10-27');
t('AC8 the saved budget is kept', p3.budget.actionsUsd, 40);
t('AC8 a dropped source comes back as new', one(p3, 'vercel:voice-pa/voicepa-docs').status, 'new');
const gone = propose({ found: { ...found, aws: { ...found.aws, profiles: ['default'] } }, saved: back, today: TODAY });
t('AC8 a saved profile no longer in the config is kept and said', one(gone, 'aws:fansurge').status, 'not found');
const unread = propose({ found: { ...found, vercel: { auth: '/a', teams: [], error: 'not signed in' } }, saved: back, today: TODAY });
t('AC8 a supplier that could not be read keeps its sources as saved', one(unread, 'vercel:ben-lavenders-projects/forewatt').status, 'saved');
const plan = propose({ found: { ...found, vercel: { ...found.vercel, teams: withProjects.map((x) => (x.id === 'team_vpa' ? { ...x, plan: 'enterprise' } : x)) } }, saved: back, today: TODAY });
t('AC8 a changed plan is refreshed and said', `${one(plan, 'vercel:voice-pa/voicepa-web').plan} ${one(plan, 'vercel:voice-pa/voicepa-web').status}`, 'enterprise changed');

// ---- the CLI, end to end (AC1, AC2, AC6, AC8, AC9)
const T = mkdtempSync(join(tmpdir(), 'desk-costs-'));
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== 'Bearer vercel-fixture-token') return send(403, { error: { code: 'forbidden' } });
  if (u.pathname === '/v2/teams') return send(200, TEAMS);
  if (u.pathname === '/v9/projects') return send(200, PROJECTS[u.searchParams.get('teamId')]?.[u.searchParams.get('until') ? 1 : 0] ?? { projects: [] });
  return send(404, {});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
try {
  for (const r of REPOS) {
    mkdirSync(join(T, 'config', 'repos', r.slug), { recursive: true });
    writeFileSync(join(T, 'config', 'repos', r.slug, 'config.md'), `## 0. Repo\n\n| Field | Value | Notes |\n|---|---|---|\n| GitHub repo | \`${r.ghRepo}\` | x |\n`);
  }
  mkdirSync(join(T, 'bin'));
  writeFileSync(join(T, 'bin', 'gh'), '#!/bin/sh\n[ "$1 $2" = "api user" ] && echo bigbenjoman\n');
  chmodSync(join(T, 'bin', 'gh'), 0o755);
  writeFileSync(join(T, 'aws'), AWS);
  writeFileSync(join(T, 'auth.json'), JSON.stringify({ token: 'vercel-fixture-token' }));
  const costs = join(T, 'config', 'costs.md');
  const env = { ...process.env, PATH: `${join(T, 'bin')}:${process.env.PATH}`, HOME: T, DESK_CONFIG_ROOT: join(T, 'config'),
    DESK_COSTS: costs, DESK_VERCEL_AUTH: join(T, 'auth.json'), DESK_VERCEL_API: `http://127.0.0.1:${server.address().port}`, AWS_CONFIG_FILE: join(T, 'aws') };
  for (const k of ['DESK_CONFIG', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_MACHINE']) delete env[k];
  const cli = (...a) => new Promise((res) => execFile('node', [join(BIN, 'desk-env.mjs'), 'costs', ...a], { env, cwd: T, encoding: 'utf8' },
    (err, stdout, stderr) => res({ rc: err ? err.code ?? 1 : 0, out: stdout + stderr })));

  let r = await cli('show');
  t('AC10 show with no file: no cost sources, exit 0', `${r.rc} ${/^no cost sources/.test(r.out)}`, '0 true');
  r = await cli('detect');
  t('detect: the gh login', /github \(gh signed in as bigbenjoman\)/.test(r.out), true);
  t('detect: a team, its plan and every page of projects', /voice-pa\s+team_vpa\s+plan pro\s+projects: voicepa-web, voicepa-admin, voicepa-docs/.test(r.out), true);
  t('detect: the token is never printed', r.out.includes('vercel-fixture-token'), false);
  t('detect: AWS profiles', /\n {2}fansurge\n/.test(r.out), true);
  r = await cli('propose', '--actions-budget', '50');
  t('AC1 propose: shown against names', /fansurge\s+none \(no repo in desk\)\s+aws:fansurge/.test(r.out), true);
  t('AC4 propose: the shared plan said', r.out.includes('vercel team ben-lavenders-projects bills more than one name'), true);
  t('AC9 propose writes nothing', existsSync(costs), false);
  r = await cli('write', '--actions-budget', '50', '--credit', 'fansurge=900@2027-01-31');
  t('AC2 write: written', `${r.rc} ${existsSync(costs)}`, '0 true');
  const saved = readCosts(costs);
  t('AC6 write: the budget stored', saved.budget.actionsUsd, 50);
  t('AC2 write: every name', Object.keys(costsByName(saved)).sort().join(), 'default,fansurge,forewatt,gygg-platform,pr-ninja,pranicuk,voicepa,yield-index');
  const before = readFileSync(costs, 'utf8');
  writeFileSync(join(T, 'aws'), `${AWS}[profile newco]\n`);
  r = await cli('propose');
  t('AC8 re-run: the new profile proposed', /newco\s+none \(no repo in desk\)\s+aws:newco\s+no credit entered\s+new/.test(r.out), true);
  t('AC8 re-run: the saved credit shown', /aws:fansurge\s+credit \$900 until 2027-01-31/.test(r.out), true);
  t('AC8 re-run: nothing changes until confirmed', readFileSync(costs, 'utf8'), before);
  r = await cli('show', '--json');
  t('AC10 show --json: each name as data', JSON.parse(r.out).names.voicepa.vercel[0].team, 'voice-pa');
  r = await cli('write', '--drop', 'aws:newco');
  t('write again keeps a backup', existsSync(`${costs}.bak`), true);
  t('write again keeps the budget', readCosts(costs).budget.actionsUsd, 50);
  writeFileSync(join(T, 'auth.json'), '{}');
  r = await cli('propose');
  t('vercel signed out: said, and saved teams kept', `${/warning: vercel: not signed in/.test(r.out)} ${/voice-pa\/voicepa-web\s+team voice-pa \(team_vpa\), plan pro\s+saved/.test(r.out)}`, 'true true');
  r = await cli('write', '--name', 'aws:nope=x');
  t('write: an unknown source is refused and nothing written', `${r.rc !== 0} ${/no source aws:nope/.test(r.out)}`, 'true true');
} finally {
  server.close();
  rmSync(T, { recursive: true, force: true });
}

console.log(fails ? `${fails} FAILED` : 'all cost source checks passed');
process.exit(fails ? 1 : 0);
