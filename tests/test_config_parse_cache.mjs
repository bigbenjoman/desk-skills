// suite: desk-env config parse cache (each config.md read once until it changes)
// covers: desk/bin/desk-env.mjs
// Fixture repo configs and queues under a throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT; reads of
// config.md are counted by wrapping fs.readFileSync before desk-env loads.
import fs, { mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');

const reads = new Map();
const realRead = fs.readFileSync;
fs.readFileSync = function (path, ...rest) {
  if (typeof path === 'string' && path.endsWith('config.md')) reads.set(path, (reads.get(path) ?? 0) + 1);
  return realRead.call(this, path, ...rest);
};
syncBuiltinESMExports();

const T = scratch('config-cache-');
Object.assign(process.env, { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'), DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills') });
writeFileSync(process.env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
const config = (slug) => join(process.env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md');
const body = (port) => `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${port}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`2 / 3\` |\n` +
  '\n## 3. Permissions\n\n| Key | Your setting |\n|---|---|\n| `ci-rerun` | `yes` |\n';
const writeConfig = (slug, port) => { mkdirSync(dirname(config(slug)), { recursive: true }); writeFileSync(config(slug), body(port)); };

// AC1: four repos, each with a queue; building the home view reads each config.md at most once.
const slugs = ['acme__one', 'acme__two', 'acme__three', 'acme__four'];
slugs.forEach((slug, i) => {
  writeConfig(slug, 3100 + i * 10);
  const q = join(process.env.DESK_HOME, 'repos', slug, 'queue.json');
  mkdirSync(dirname(q), { recursive: true });
  writeFileSync(q, JSON.stringify({ version: 1, batch: `b${i}`, concurrency: 2, tickets: { [`K${i}-1`]: { key: `K${i}-1`, state: 'running', stage: '3/9' }, [`K${i}-2`]: { key: `K${i}-2`, state: 'queued' } } }));
});
const Q = await import(join(BIN, 'desk-q.mjs'));
const E = await import(join(BIN, 'desk-env.mjs'));
// `all`: whether the home view shows a quiet repo hangs on the machine (with launchd or systemd its
// session-run batch is one to hand over, and shown; on CI's runner it is not), and this suite counts
// reads, not which repos are shown.
const home = Q.homeJson(Q.loadRepos(), { all: true, avail: 30 });
t('AC1 the home view shows the four repos', home.repos?.length, 4);
t('AC1 each config.md is read at most once while the home view is built', slugs.map((s) => reads.get(config(s)) ?? 0).map((n) => n <= 1), [true, true, true, true]);
Q.homeJson(Q.loadRepos(), { all: true, avail: 30 });
t('AC1 a second build of the home view reads no config.md again', slugs.map((s) => reads.get(config(s)) ?? 0).map((n) => n <= 1), [true, true, true, true]);

// AC2: an edit made after the first read is returned, with no clearing by hand.
const one = slugs[0];
t('AC2 the first read', E.repoConfigValue(one, 'dev-port'), '3100');
writeFileSync(config(one), body(4100));
const later = new Date(Date.now() + 5000);
utimesSync(config(one), later, later);
t('AC2 an edited config.md is read again', E.repoConfigValue(one, 'dev-port'), '4100');

// AC3: the same modification time but a different size is a different file.
const two = slugs[1];
const at = new Date('2026-01-02T03:04:05Z');
utimesSync(config(two), at, at);
t('AC3 the first read', E.repoConfigValue(two, 'dev-port'), '3110');
writeFileSync(config(two), body(31100));
utimesSync(config(two), at, at);
t('AC3 the replacing file has the same modification time', statSync(config(two)).mtimeMs, at.getTime());
t('AC3 its value is returned', E.repoConfigValue(two, 'dev-port'), '31100');

// AC4: a missing config reads unset, and one created afterwards is read on the next call.
const late = 'acme__late';
t('AC4 a missing config.md reads unset', E.repoConfigValue(late, 'dev-port'), null);
t('AC4 a missing config.md has no permission row', E.repoPermissionUnset(late, 'ci-rerun'), false);
writeConfig(late, 3900);
t('AC4 a config created afterwards is read on the next call', E.repoConfigValue(late, 'dev-port'), '3900');
t('AC4 and its permission rows with it', E.repoPermission(late, 'ci-rerun'), 'yes');

// AC2 and AC4 for this repo's own config, read by configValue rather than by slug.
const own = join(T, 'own', 'config.md');
process.env.DESK_CONFIG = own;
t('AC4 own config: missing reads unset', E.configValue('dev-port'), null);
mkdirSync(dirname(own), { recursive: true });
writeFileSync(own, body(3500));
t('AC4 own config: created afterwards is read on the next call', E.configValue('dev-port'), '3500');
writeFileSync(own, body(3600));
const after = new Date(Date.now() + 10000);
utimesSync(own, after, after);
t('AC2 own config: an edit is read on the next call', E.configValue('dev-port'), '3600');
delete process.env.DESK_CONFIG;

// A desk-env command answers every row from the parse it started with. The preload rewrites the
// config on the second stat of it, which only a command that re-reads the file per row ever makes.
const midEdit = (name, before, after, ...argv) => {
  const cfg = join(T, name, 'config.md'), stats = join(T, name, 'stats'), hook = join(T, name, 'hook.mjs');
  mkdirSync(dirname(cfg), { recursive: true });
  writeFileSync(cfg, before);
  writeFileSync(hook, `import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nconst real = fs.statSync;\nlet n = 0;\n` +
    `fs.statSync = function (p, ...rest) {\n  if (p === ${JSON.stringify(cfg)}) {\n    fs.writeFileSync(${JSON.stringify(stats)}, String(++n));\n` +
    `    if (n === 2) { fs.writeFileSync(p, ${JSON.stringify(after)}); const t = new Date(Date.now() + 20000); fs.utimesSync(p, t, t); }\n  }\n  return real.call(this, p, ...rest);\n};\nsyncBuiltinESMExports();\n`);
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, join(BIN, 'desk-env.mjs'), ...argv], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: cfg } });
  return { out: r.stdout, stats: realRead(stats, 'utf8') };
};
const json = midEdit('snap-json', body(3700), body(4700), 'get', '--json', 'gh-repo', 'dev-port');
t('one get --json stats the config once', json.stats, '1');
t('one get --json reads every row from the version it started with', JSON.parse(json.out).rows['dev-port']?.value, '3700');
// merge-grant needs two rows yes: an edit swapping which one is yes grants nothing in either version.
const merge = (a, b) => `${body(3800)}| \`autopilot-merge\` | \`${a}\` |\n| \`pr-merge-green\` | \`${b}\` |\n`;
const grant = midEdit('snap-grant', merge('yes', 'no'), merge('no', 'yes'), 'merge-grant');
t('one merge-grant stats the config once', grant.stats, '1');
t('one merge-grant grants nothing neither version grants', grant.out.split('\t')[0], 'none');

fs.readFileSync = realRead;
syncBuiltinESMExports();
rmSync(T, { recursive: true, force: true });
if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
