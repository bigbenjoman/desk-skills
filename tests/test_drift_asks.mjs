// suite: drift asks (the config rows a release added that a repo's config lacks: desk sets those it can, and asks the rest)
// layer: L1
// covers: desk/bin/drift-asks.mjs
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const T = scratch('drift-asks-');
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_AUTOPILOT_STATE', 'DESK_QUEUE', 'DESK_CONFIG', 'DESK_BATCH']) delete process.env[k];
Object.assign(process.env, { HOME: join(T, 'home'), DESK_CONFIG_ROOT: join(T, 'cfg'), DESK_CONFIG_TEMPLATE: join(T, 'template.md') });
const perms = (rows) => `## 3. Permissions\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n${rows.map(([k, v]) => `| \`${k}\` | x | \`ask\` | ${v} |`).join('\n')}\n`;
const table = (rows) => `## 4. Checks\n| Field | Value |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n`;
const repo = join(T, 'repo');
const cfgPath = (slug) => join(T, 'cfg', 'repos', slug, 'config.md');
const config = (slug, { perm = [['autopilot-workers', '`yes`']], rows }) => {
  mkdirSync(join(T, 'cfg', 'repos', slug), { recursive: true });
  writeFileSync(cfgPath(slug), `## 2. Paths\n| Field | Value |\n|---|---|\n| Primary repo root | \`${repo}\` |\n\n${perms(perm)}\n${table(rows)}`);
};
writeFileSync(join(T, 'template.md'), `## 2. Paths\n| Field | Value |\n|---|---|\n| Primary repo root | TODO |\n\n${perms([['autopilot-workers', 'TODO'], ['worker-preview-db', 'TODO']])}\n${table([['Dev server', 'TODO'], ['Test sign-in', 'TODO'], ['Preview database', 'TODO'], ['Staging', 'TODO']])}`);
mkdirSync(join(repo, 'prisma'), { recursive: true });
writeFileSync(join(repo, 'prisma', 'seed.ts'), "await db.user.create({ data: { email: 'maya.dev@acme.test', role: 'admin' } });\n");
mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true });
writeFileSync(join(repo, 'node_modules', 'x', 'seed.js'), "'skip@nowhere.test'\n");

const D = await import('../desk/bin/drift-asks.mjs');
const { readAsks } = await import('../desk/bin/asks.mjs');
const E = await import('../desk/bin/desk-env.mjs');
const decisions = (slug) => { const p = join(E.batchPaths(slug).state, 'decisions.jsonl'); return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []; };

t('#1361 a seed file names the user it creates', JSON.stringify(D.seededUser(repo)), JSON.stringify({ email: 'maya.dev@acme.test', file: 'prisma/seed.ts' }));
t('#1361 a repo with no seed file names none', D.seededUser(join(T, 'cfg')), null);

// What desk takes itself, and what it leaves to the person.
const m = (section, label) => ({ section, label });
t('#1363 a §3 permission the config lacks is taken as no, which it already reads as', D.considered(m('3', 'worker-preview-db'))?.value, 'no');
t('#1363 a row whose template default already applies is taken as that default', D.considered(m('4', '"Preview database"'))?.value, 'none');
t('#1363 Test sign-in is taken as the seeded user, for the one app', D.considered(m('4', '"Test sign-in"'), { root: repo, devDirs: ['apps/web'] })?.value, 'apps/web: maya.dev@acme.test');
t('#1363 with two apps, which user for which is the person\'s', D.considered(m('4', '"Test sign-in"'), { root: repo, devDirs: ['apps/web', 'apps/admin'] }), null);
t('#1363 a row with no default and nothing to read is the person\'s', D.considered(m('4', '"Staging"'), { root: repo }), null);
t('#1363 a §3 row never or stop is not taken', D.considered(m('3', 'legal-content')), null);
t('#1363 a row the machine profile fills while it is absent is left absent, neither set nor asked', JSON.stringify(D.considered(m('3b', '"Autopilot worker concurrency"'))), JSON.stringify({ leave: true }));

config('acme__lacks', { rows: [['Dev server', '`npm run dev`']] });
config('acme__full', { perm: [['autopilot-workers', '`yes`'], ['worker-preview-db', '`no`']], rows: [['Dev server', '`npm run dev`'], ['Test sign-in', '`dev@acme.test`'], ['Preview database', '`none`'], ['Staging', '`none`']] });
const lines = D.recordDriftAsks({ short: 'abc12345' });
t('#1363 desk sets the rows it can, and puts only the rest to the person, one line each',
  lines.join('\n'), 'acme__lacks had 3 config row(s) desk set itself, each noted as desk\'s and in the check-in digest (§3 worker-preview-db = no; §4 "Test sign-in" = maya.dev@acme.test; §4 "Preview database" = none)\n'
  + 'acme__lacks lacks 1 config row(s) this release has that need the person (§4 "Staging"), now on its needs-you list as ask:1');
const text = readFileSync(cfgPath('acme__lacks'), 'utf8');
t('#1363 each row desk set is noted as desk\'s, with why', /\| Test sign-in \| `maya\.dev@acme\.test` \(set by desk: a development user prisma\/seed\.ts creates; /.test(text) && /\| `worker-preview-db` \| x \| `ask` \| `no` \(set by desk: a §3 row the config lacks already reads as no/.test(text), true);
const ds = decisions('acme__lacks');
t('#1363 each is a taken decision the check-in digest lists, saying how to change it', `${ds.length} ${ds.every((d) => d.ticket === 'config' && d.category === 'engineering' && d.options.at(-1) === 'ask the person' && d.question.includes('To change it, edit the row in'))} ${ds.map((d) => d.chose).join(',')}`, '3 true no,maya.dev@acme.test,none');
const asks = readAsks(E.batchPaths('acme__lacks').state);
t('#1363 the ask names only the row that needs the person, and points at /desk-setup\'s choices, not a typed value',
  asks.length === 1 && asks[0].text === 'config drift: desk abc12345 added a config row this repo\'s config lacks that need you: §4 "Staging". Run /desk-setup in the repo: it puts each to you as a choice, its recommendation first', true);
t('#1361 it records the rows it waits on', JSON.stringify([asks[0]?.settles, asks[0]?.rows]), JSON.stringify(['drift', ['§4 "Staging"']]));
t('#1361 a repo with nothing missing gets no ask and no decision', `${readAsks(E.batchPaths('acme__full').state).length} ${decisions('acme__full').length}`, '0 0');

D.recordDriftAsks({ short: 'def67890' });
t('#1361 a later install with the same rows missing keeps the ask as it was, and sets nothing again', `${JSON.stringify(readAsks(E.batchPaths('acme__lacks').state).map((a) => a.id))} ${decisions('acme__lacks').length}`, '[1] 3');
config('acme__lacks', { rows: [['Dev server', '`npm run dev`'], ['Test sign-in', '`dev@acme.test`'], ['Preview database', '`none`'], ['Staging', '`none`']], perm: [['autopilot-workers', '`yes`'], ['worker-preview-db', '`no`']] });
t('#1361 once the config has the rows, the next install drops the ask', `${D.recordDriftAsks({}).filter((l) => l.startsWith('acme__lacks')).length} ${readAsks(E.batchPaths('acme__lacks').state).length}`, '0 0');

// A row the config refuses (no table for it to sit in) goes to the person instead.
mkdirSync(join(T, 'cfg', 'repos', 'acme__notable'), { recursive: true });
writeFileSync(cfgPath('acme__notable'), `## 2. Paths\n| Field | Value |\n|---|---|\n| Primary repo root | \`${repo}\` |\n\n${table([['Dev server', '`npm run dev`'], ['Test sign-in', '`dev@acme.test`'], ['Preview database', '`none`'], ['Staging', '`none`']])}`);
const nt = D.recordDriftAsks({});
t('#1363 a row desk could not write is put to the person with the rest', nt.some((l) => l.startsWith('acme__notable lacks ') && l.includes('§3 worker-preview-db')), true);

// A decision log that cannot be written is named: the row stays set, but the digest cannot list it.
config('acme__nolog', { rows: [['Dev server', '`npm run dev`'], ['Test sign-in', '`dev@acme.test`'], ['Staging', '`none`']], perm: [['autopilot-workers', '`yes`'], ['worker-preview-db', '`no`']] });
mkdirSync(join(E.batchPaths('acme__nolog').state, 'decisions.jsonl'), { recursive: true });
const nl = D.recordDriftAsks({}).filter((l) => l.startsWith('acme__nolog'));
t('#1363 a row whose decision could not be logged is named, and not said to be in the digest',
  `${nl[0]} | ${nl[1]?.startsWith('acme__nolog\'s decision log could not be written for §4 "Preview database" (')}`, 'acme__nolog had 1 config row(s) desk set itself, each noted as desk\'s (§4 "Preview database" = none) | true');

// One repo's unreadable asks file leaves the next repo's ask recorded.
config('acme__a1', { rows: [['Dev server', '`npm run dev`']] });
config('acme__a2', { rows: [['Dev server', '`npm run dev`']] });
mkdirSync(E.batchPaths('acme__a1').state, { recursive: true });
writeFileSync(join(E.batchPaths('acme__a1').state, 'asks.json'), '{not json');
const broken = D.recordDriftAsks({});
t('#1361 a repo whose asks cannot be written is named, and the next repo still gets its ask',
  `${broken.some((l) => l.startsWith("acme__a1's drift could not be checked or recorded"))} ${readAsks(E.batchPaths('acme__a2').state).length}`, 'true 1');

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
