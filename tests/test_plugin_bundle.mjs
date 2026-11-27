// suite: plugin bundle (desk-review, its finder agents and the desk scripts they import, as a Claude Code plugin)
// layer: L2
// covers: desk/bin/plugin-build.mjs desk/bin/import-closure.mjs skills/desk-review/** agents/**
// issue-1561. plugin-build.mjs writes a marketplace holding the `desk` plugin: the desk-review skill,
// the agents it names, and the import closure of the desk scripts it calls, copied (Claude Code
// refuses a symlink out of a plugin). Builds into scratch directories, runs the bundled desk-env and
// verdict.mjs under an empty HOME, and builds a fixture repo whose script imports a missing file.
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';
import { build, bundle, importsOf, scriptClosure, MARKETPLACE, PLUGIN } from '../desk/bin/plugin-build.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

const out = join(scratch('plugin-bundle-'), 'market');
const built = spawnSync(process.execPath, [join(root, 'desk/bin/plugin-build.mjs'), out], { encoding: 'utf8' });
t('the build runs', [built.status, built.stderr.trim()], [0, '']);
const dir = join(out, PLUGIN);
const files = walk(dir).map((p) => relative(dir, p)).sort();

// AC1: the manifests.
const market = json(join(out, '.claude-plugin/marketplace.json'));
t('AC1 marketplace.json names the marketplace, its owner and the plugin at ./desk',
  [market.name, market.owner?.name, market.plugins.map((p) => [p.name, p.source])], [MARKETPLACE, MARKETPLACE, [[PLUGIN, './desk']]]);
const plugin = json(join(dir, '.claude-plugin/plugin.json'));
const manifest = json(join(dir, '.claude-plugin/bundle.json'));
t('AC1 plugin.json names the plugin and has a version', [plugin.name, /^0\.0\.0-/.test(plugin.version)], [PLUGIN, true]);
t('AC1 plugin.json lists the same agents as the bundle manifest', plugin.agents, manifest.agents);
t('AC1 the bundle manifest lists the desk-review skill', manifest.skills, ['./skills/desk-review']);
const listed = [...manifest.skills, ...manifest.agents, ...manifest.scripts, ...manifest.commands];
t('AC1 every listed path starts ./ and is in the plugin', listed.filter((p) => !p.startsWith('./') || !existsSync(join(dir, p))), []);

// AC1: the finder agents are the ones desk-review routes to and refutes with.
const route = readFileSync(join(root, 'skills/desk-review/references/phase-2-route.md'), 'utf8');
const routed = [...route.matchAll(/^\| [a-z]+ \| `([a-z]+-[a-z-]+)` \|/gm)].map((m) => m[1]);
const agents = manifest.agents.map((a) => a.replace(/^\.\/agents\/|\.md$/g, ''));
t(`AC1 every agent in the routing table ships (${routed.length})`, routed.length >= 6 && routed.filter((a) => !agents.includes(a)), []);
t('AC1 the same-vendor refuter ships', agents.includes('ada-devils-advocate'), true);
t('AC1 an agent desk-review never names does not', agents.includes('muriel-design-engineer'), false);

// AC1: the scripts, worked out from the imports, checked here against the built tree itself.
const mjs = files.filter((f) => f.endsWith('.mjs'));
const unresolved = mjs.flatMap((f) => importsOf(dir, f).filter((i) => !existsSync(join(dir, i))).map((i) => `${f} -> ${i}`));
t(`AC1 every import of every bundled script (${mjs.length}) is in the bundle`, unresolved, []);
const skillText = files.filter((f) => f.startsWith('skills/')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
const calls = [...new Set([...skillText.matchAll(/node <desk bin>\/([\w.-]+)/g)].map((m) => m[1]))];
t(`AC1 every script the skill calls is in the plugin's desk/bin (${calls.length})`, calls.length >= 3 && calls.filter((s) => !existsSync(join(dir, 'desk/bin', s))), []);
t('AC1 every bundled script is listed in the manifest', files.filter((f) => f.startsWith('desk/')).map((f) => `./${f}`), manifest.scripts);
t('AC1 the shims are executable and on bin/', manifest.commands.map((c) => [c, (statSync(join(dir, c)).mode & 0o111) !== 0]),
  [['./bin/desk-env', true], ['./bin/desk-codex', true], ['./bin/desk-gh', true]]);
t('AC1 each file is a copy of the repo one', files.filter((f) => !f.startsWith('.claude-plugin/') && !f.startsWith('bin/'))
  .filter((f) => readFileSync(join(dir, f), 'utf8') !== readFileSync(join(root, f), 'utf8')), []);

// Out of scope: no batch, pass or setup entry point, and no other skill. Libraries those share are
// fair game (harvest.mjs ships: desk-env's lazy subcommands reach it through queue-store.mjs).
const machinery = ['pass.mjs', 'queue.mjs', 'batch.mjs', 'spawn-worker.sh', 'merge-driver.sh', 'setup-worktree.sh', 'supervisor.mjs']
  .filter((s) => existsSync(join(dir, 'desk/bin', s)));
t('no batch, pass or setup script ships', machinery, []);
t('desk-review is the only skill', readdirSync(join(dir, 'skills')), ['desk-review']);

// AC1: the build refuses a bundle whose import is missing, and follows every import form.
const fx = scratch('plugin-fixture-');
const put = (f, s) => { mkdirSync(dirname(join(fx, f)), { recursive: true }); writeFileSync(join(fx, f), s); };
put('skills/desk-review/SKILL.md', 'Route to `lena-code-reviewer`.\n\n```bash\nnode <desk bin>/review-post.mjs 1\n```\n');
put('skills/desk-review/bin/verdict.mjs', "import { x } from './own.mjs';\n");
put('skills/desk-review/bin/own.mjs', 'export const x = 1;\n');
put('agents/lena-code-reviewer.md', 'lena\n');
put('agents/muriel-design-engineer.md', 'muriel\n');
for (const s of ['desk-env', 'desk-codex', 'desk-gh']) put(`desk/bin/${s}.mjs`, "import './side.mjs';\n");
put('desk/bin/side.mjs', '');
put('desk/bin/review-post.mjs', "import {\n  a,\n} from './a.mjs';\nexport * from './pass/b.mjs';\nconst c = await import('./c.mjs');\n");
put('desk/bin/a.mjs', ''); put('desk/bin/pass/b.mjs', "import '../a.mjs';\n"); put('desk/bin/c.mjs', '');
put('desk/bin/pass.mjs', '');
const fb = bundle(fx);
t('AC1 the closure follows multi-line, re-export, side-effect, dynamic and subfolder imports', fb.manifest.scripts,
  ['./desk/bin/a.mjs', './desk/bin/c.mjs', './desk/bin/desk-codex.mjs', './desk/bin/desk-env.mjs', './desk/bin/desk-gh.mjs', './desk/bin/pass/b.mjs', './desk/bin/review-post.mjs', './desk/bin/side.mjs']);
t('AC1 the skill keeps its own bin, with what that imports', fb.copies.map((c) => c.to).filter((f) => f.startsWith('skills/')),
  ['skills/desk-review/SKILL.md', 'skills/desk-review/bin/own.mjs', 'skills/desk-review/bin/verdict.mjs']);
t('AC1 only the agents the skill names ship', fb.manifest.agents, ['./agents/lena-code-reviewer.md']);
put('desk/bin/c.mjs', "import { gone } from './gone.mjs';\n");
let refused = '';
try { bundle(fx); } catch (e) { refused = e.message; }
t('AC1 a script importing a file that is not there fails the build, naming both', refused.includes('desk/bin/c.mjs -> desk/bin/gone.mjs'), true);
t('AC1 scriptClosure reports it as missing', scriptClosure(fx, ['desk/bin/review-post.mjs']).missing, ['desk/bin/c.mjs -> desk/bin/gone.mjs']);
t('AC1 and an entry that is not there', scriptClosure(fx, ['desk/bin/nope.mjs']).missing, ['desk/bin/nope.mjs']);
put('desk/bin/c.mjs', "// import { gone } from './gone.mjs';\nconst s = \"import './gone.mjs'\";\n");
t('AC1 an import in a comment or a string is not followed', scriptClosure(fx, ['desk/bin/review-post.mjs']).missing, []);

// The build replaces an earlier build and refuses a directory that is not one.
const again = spawnSync(process.execPath, [join(root, 'desk/bin/plugin-build.mjs'), out], { encoding: 'utf8' });
t('a second build over the first replaces it', again.status, 0);
const foreign = scratch('plugin-foreign-'); writeFileSync(join(foreign, 'keep.txt'), 'x');
let kept = '';
try { build(foreign); } catch (e) { kept = e.message; }
t('a non-empty directory that holds no build is refused and left alone', [kept.includes('holds no earlier build'), existsSync(join(foreign, 'keep.txt'))], [true, true]);

// AC2, the parts a test can run: under an empty HOME with no desk config, the plugin's desk-env reads
// DESK_CONFIG_FILE (stage 2), and its verdict.mjs prints a desk-format verdict.
const s = scratch('plugin-run-');
const home = join(s, 'home'); const repo = join(s, 'repo'); mkdirSync(home); mkdirSync(repo);
const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(s, 'gitconfig') };
writeFileSync(env.GIT_CONFIG_GLOBAL, '');
spawnSync('git', ['init', '-q', '-b', 'main', repo], { env });
spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env });
writeFileSync(join(s, 'rows.json'), JSON.stringify({ 'review-bar': 'default', 'required-checks': ['Tests'] }));
const run = (cmd, args, extra = {}) => spawnSync(cmd, args, { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8' });
const where = run(join(dir, 'bin/desk-env'), ['where']);
t('AC2 the bundled desk-env finds the repo with no config', [where.status, where.stdout.includes("SLUG='acme__widgets'"), where.stdout.includes('EXISTS=no')], [0, true, true]);
const bar = run(join(dir, 'bin/desk-env'), ['get', 'review-bar'], { DESK_CONFIG_FILE: join(s, 'rows.json') });
const checks = run(join(dir, 'bin/desk-env'), ['list', 'required-checks'], { DESK_CONFIG_FILE: join(s, 'rows.json') });
t('AC2 and answers the review rows from DESK_CONFIG_FILE', [bar.status, bar.stdout.trim(), checks.stdout.trim()], [0, 'default', 'Tests']);
const sha = '0123456789abcdef0123456789abcdef01234567';
writeFileSync(join(s, 'results.json'), JSON.stringify({ sha, round: 1, gaps: 0, skipped_files: 0,
  seats: [{ role: 'correctness', vendor: 'claude', status: 'ran' }, { role: 'codex', vendor: 'codex', status: 'ran' }], findings: [] }));
const verdict = run(process.execPath, [join(dir, 'skills/desk-review/bin/verdict.mjs'), join(s, 'results.json')]);
t('AC2 the bundled verdict.mjs prints the clean desk verdict marker', [verdict.status, verdict.stdout.includes(`<!-- desk-review:verdict v=1 sha=${sha} p0=0 p1=0 p2=0`)], [0, true]);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
