// suite: drift asks (the config rows a release added that a repo's config lacks, put on its needs-you list at install)
// layer: L1
// covers: desk/bin/drift-asks.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const T = scratch('drift-asks-');
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_AUTOPILOT_STATE', 'DESK_QUEUE', 'DESK_CONFIG', 'DESK_BATCH']) delete process.env[k];
Object.assign(process.env, { HOME: join(T, 'home'), DESK_CONFIG_ROOT: join(T, 'cfg'), DESK_CONFIG_TEMPLATE: join(T, 'template.md') });
const table = (rows) => `## 4. Checks\n| Field | Value |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n`;
const repo = join(T, 'repo');
const config = (slug, rows) => {
  mkdirSync(join(T, 'cfg', 'repos', slug), { recursive: true });
  writeFileSync(join(T, 'cfg', 'repos', slug, 'config.md'), `## 2. Paths\n| Field | Value |\n|---|---|\n| Primary repo root | \`${repo}\` |\n\n${table(rows)}`);
};
writeFileSync(join(T, 'template.md'), `## 2. Paths\n| Field | Value |\n|---|---|\n| Primary repo root | TODO |\n\n${table([['Dev server', 'TODO'], ['Test sign-in', 'TODO']])}`);
mkdirSync(join(repo, 'prisma'), { recursive: true });
writeFileSync(join(repo, 'prisma', 'seed.ts'), "await db.user.create({ data: { email: 'maya.dev@acme.test', role: 'admin' } });\n");
mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true });
writeFileSync(join(repo, 'node_modules', 'x', 'seed.js'), "'skip@nowhere.test'\n");

const D = await import('../desk/bin/drift-asks.mjs');
const { readAsks } = await import('../desk/bin/asks.mjs');
const E = await import('../desk/bin/desk-env.mjs');

t('#1361 a seed file names the user it creates', JSON.stringify(D.seededUser(repo)), JSON.stringify({ email: 'maya.dev@acme.test', file: 'prisma/seed.ts' }));
t('#1361 a repo with no seed file names none', D.seededUser(join(T, 'cfg')), null);

config('acme__lacks', [['Dev server', '`npm run dev`']]);
config('acme__full', [['Dev server', '`npm run dev`'], ['Test sign-in', '`dev@acme.test`']]);
const lines = D.recordDriftAsks({ short: 'abc12345' });
t('#1361 one line per repo lacking a row, none for one that has them all', lines.join('\n'), 'acme__lacks lacks 1 config row(s) this release has (§4 "Test sign-in"), now on its needs-you list as ask:1');
const asks = readAsks(E.batchPaths('acme__lacks').state);
t('#1361 the ask names the row, with a recommended user from the seed files', asks.length === 1 && asks[0].text.startsWith('config drift: desk abc12345 added a config row this repo\'s config lacks: §4 "Test sign-in" (recommended: `maya.dev@acme.test`, a user prisma/seed.ts creates: confirm it holds the grant its signed-in pages need).'), true);
t('#1361 it records the rows it waits on', JSON.stringify([asks[0].settles, asks[0].rows]), JSON.stringify(['drift', ['§4 "Test sign-in"']]));
t('#1361 a repo with nothing missing gets no ask', readAsks(E.batchPaths('acme__full').state).length, 0);

D.recordDriftAsks({ short: 'def67890' });
t('#1361 a later install with the same rows missing keeps the ask as it was', JSON.stringify(readAsks(E.batchPaths('acme__lacks').state).map((a) => [a.id, a.text.slice(0, 30)])), JSON.stringify([[1, 'config drift: desk abc12345 ad']]));
config('acme__lacks', [['Dev server', '`npm run dev`'], ['Test sign-in', '`dev@acme.test`']]);
t('#1361 once the config has the rows, the next install drops the ask', `${D.recordDriftAsks({}).join()} ${readAsks(E.batchPaths('acme__lacks').state).length}`, 'no configured repo lacks a config row this release has 0');

// One repo's unreadable asks file leaves the next repo's ask recorded.
config('acme__a1', [['Dev server', '`npm run dev`']]);
config('acme__a2', [['Dev server', '`npm run dev`']]);
mkdirSync(E.batchPaths('acme__a1').state, { recursive: true });
writeFileSync(join(E.batchPaths('acme__a1').state, 'asks.json'), '{not json');
const broken = D.recordDriftAsks({});
t('#1361 a repo whose asks cannot be written is named, and the next repo still gets its ask',
  `${broken.some((l) => l.startsWith("acme__a1's drift could not be checked or recorded")) } ${readAsks(E.batchPaths('acme__a2').state).length}`, 'true 1');

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
