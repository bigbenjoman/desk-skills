// suite: CI scope (the suites a pull request's change reaches; anything unplaced runs every suite)
// layer: L2
// claims: imports (repo file names below are test data, not what this suite runs)
// tests/scope_sections.mjs on a made-up tree, then on this repo, then tests/run.sh's suite filter.
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMap, decide, mentions, globRe, loads, parseNameStatus, repoMap, addedExports, changedNames, ALWAYS, LAYERS, suiteHeader, importClosure, changesAgainst } from './scope_sections.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const g = JSON.stringify(got); const w = JSON.stringify(want); const ok = g === w; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`); };
const R = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- the pieces --------------------------------------------------------------------------------
t('a quoted path gives every ending', [...mentions('x "$SRC/desk/bin/merge-driver.sh" y')].filter((m) => m.includes('merge')).sort(), ['SRC/desk/bin/merge-driver.sh', 'bin/merge-driver.sh', 'desk/bin/merge-driver.sh', 'merge-driver.sh']);
t('a hyphenated name is not its tail', mentions('base-gate.mjs').has('gate.mjs'), false);
t('./x.mjs is x.mjs', mentions("from './gate.mjs';").has('gate.mjs'), true);
t('** spans directories, * does not', [globRe('skills/**').test('skills/a/b/c.md'), globRe('skills/*.md').test('skills/a/b.md'), globRe('skills/**/*.md').test('skills/x.md')], [true, false, true]);
t('mjs loads are imports only, not a comment or a spawned script', loads('a.mjs', "import { x } from './b.mjs';\n// see c.mjs\nconst m = await import('./d.mjs');\nspawn('node', ['e.mjs']);"), './b.mjs\n./d.mjs');
t('shell: source lines and paths built from a directory, not a bare name or a comment', loads('a.sh', '. "$B/lib.sh"\nsource x.sh\nbash run.sh\nnode "$DESK_BIN/gate.mjs" x\n"${HERE}/a b"\n$(dirname "$0")/up.sh\n# "$B/y.sh"'), '. "$B/lib.sh"\nlib.sh\nsource x.sh\ngate.mjs\na\nup.sh');
t('mjs: join(DIR, ...) and new URL(..., import.meta.url) are launches; a message is not', loads('a.mjs', "spawn(process.execPath, [join(BIN, 'base-gate.mjs')]);\nshOut(join(bin, 'sub', 'x.sh'), []);\nconst u = new URL('./y.mjs', import.meta.url);\nconsole.log('run with-lock.sh');\n// join(BIN, 'z.mjs')"), 'base-gate.mjs\nsub/x.sh\n./y.mjs');
t('mjs: an import inside a fixture string is not an import', loads('a.mjs', "const s = \"import { x } from './gate.mjs'\";\n} from './real.mjs';"), './real.mjs');
t('a rename has its old path', parseNameStatus('M\ta.sh\nR100\told.mjs\tnew.mjs'), [{ status: 'M', path: 'a.sh' }, { status: 'R', path: 'new.mjs', from: 'old.mjs' }]);

// ---- a made-up repo ------------------------------------------------------------------------------
const tree = {
  'README.md': '# readme',
  '.gitignore': 'node_modules',
  'install.sh': '#!/usr/bin/env bash\ncp -R skills ~/.agents',
  'desk/bin/desk-env.mjs': "export const x = 1; // names pass.mjs and lone.mjs, followed by nothing",
  'desk/bin/pass.mjs': "import { x } from './desk-env.mjs';\nimport { q } from './queue.mjs';\nspawn('lone.mjs')\nspawnSync(join(BIN, 'launched.mjs'))",
  'desk/bin/launched.mjs': 'export {}',
  'desk/bin/queue.mjs': "import { lock } from './lock.mjs';",
  'desk/bin/lock.mjs': 'export const lock = 1;',
  'desk/bin/lone.mjs': '// run by pass.mjs as a command; no suite names it',
  'desk/bin/drive.sh': '#!/usr/bin/env bash\n. "$(dirname "$0")/lib.sh"\nnode "$B/pass.mjs"',
  'desk/bin/lib.sh': 'helper() { :; }',
  'bin/tool': '#!/usr/bin/env bash\necho tool',
  'skills/desk-a/SKILL.md': '# a, see `desk/bin/pass.mjs`',
  'skills/desk-a/references/one.md': 'one',
  'skills/desk-b/SKILL.md': '# b',
  'skills/desk-b/bin/helper.mjs': 'export {}',
  'docs/notes.md': 'notes',
  'tests/run.sh': '#!/usr/bin/env bash',
  'tests/helper.mjs': 'export {}',
  'tests/test_lint.sh': '# suite: lint\n# covers: **\ngit ls-files',
  'tests/test_pass.mjs': "// suite: pass\nimport { run } from '../desk/bin/pass.mjs';",
  'tests/test_drive.sh': '# suite: drive\n"$SRC/desk/bin/drive.sh"\n"$SRC/bin/tool"\nnode "$SRC/desk/bin/pass.mjs"',
  'tests/test_docs.mjs': "// suite: docs\n// covers: skills/desk-*/** docs/**\nwalk('skills')",
  'tests/test_skill_a.mjs': "// suite: skill a\nread('skills/desk-a')",
  'tests/test_data.mjs': "// suite: data\n// claims: imports\nimport { z } from '../desk/bin/lock.mjs';\nconst cases = ['desk/bin/lib.sh', 'bin/tool'];",
};
const files = Object.keys(tree);
const map = buildMap(files, (p) => tree[p]);
const claims = (p) => [...(map.claims.get(p) ?? [])].sort();
t('suites and labels', map.suites.map((s) => `${s.file}=${s.label}`), ['test_data.mjs=data', 'test_docs.mjs=docs', 'test_drive.sh=drive', 'test_lint.sh=lint', 'test_pass.mjs=pass', 'test_skill_a.mjs=skill a']);
t('a suite claims what it imports, and what that imports', [claims('desk/bin/pass.mjs'), claims('desk/bin/queue.mjs'), claims('desk/bin/lock.mjs')], [['test_drive.sh', 'test_pass.mjs'], ['test_drive.sh', 'test_pass.mjs'], ['test_data.mjs', 'test_drive.sh', 'test_pass.mjs']]);
t('a suite claims the scripts it names, and what they source', [claims('desk/bin/drive.sh'), claims('desk/bin/lib.sh'), claims('bin/tool')], [['test_drive.sh'], ['test_drive.sh'], ['test_drive.sh']]);
t('a script launched by a path built from a directory is claimed through its launcher', claims('desk/bin/launched.mjs'), ['test_drive.sh', 'test_pass.mjs']);
t('a bare name in a spawn is not a launch', claims('desk/bin/lone.mjs'), []);
t('claims: imports: names in its text claim nothing, its imports do', [claims('desk/bin/lib.sh').includes('test_data.mjs'), claims('bin/tool').includes('test_data.mjs'), claims('desk/bin/lock.mjs').includes('test_data.mjs')], [false, false, true]);
t('desk-env.mjs is claimed, but nothing is followed through it', [claims('desk/bin/desk-env.mjs'), claims('desk/bin/lone.mjs')], [['test_drive.sh', 'test_pass.mjs'], []]);
t('covers claims documents, not scripts', [claims('skills/desk-b/SKILL.md'), claims('docs/notes.md'), claims('skills/desk-b/bin/helper.mjs')], [['test_docs.mjs'], ['test_docs.mjs'], []]);
t('a named skill directory claims everything under it', [claims('skills/desk-a/references/one.md'), claims('skills/desk-a/SKILL.md')], [['test_docs.mjs', 'test_skill_a.mjs'], ['test_docs.mjs', 'test_skill_a.mjs']]);
t('the always-run suites claim nothing', [...map.claims.values()].some((s) => s.has('test_lint.sh')), false);
t('shell scripts by extension or shebang', [...map.shells].sort(), ['bin/tool', 'desk/bin/drive.sh', 'desk/bin/lib.sh', 'install.sh', 'tests/run.sh', 'tests/test_drive.sh', 'tests/test_lint.sh']);

const M = (...paths) => paths.map((path) => ({ status: 'M', path }));
const scope = (ch) => { const d = decide(ch, map); return `${d.scope}: ${d.scope === 'full' ? d.reason : d.suites.join(' ')}`; };
t('nothing changed', scope([]), 'none: ' + ALWAYS.join(' '));
t('a script runs its suites and the always set', scope(M('desk/bin/lib.sh')), 'some: test_drive.sh test_lint.sh');
// The suites checking every test file against the rules for them run on any change under tests/, a
// helper included, since the layer check reads every helper a suite imports.
{
  const ctree = { ...tree, 'tests/test_scope_sections.mjs': '// suite: CI scope\n' };
  const cmap = buildMap(Object.keys(ctree), (p) => ctree[p]);
  const cscope = (ch) => decide(ch, cmap).suites.join(' ');
  t('a suite added or changed runs the checks on every test file', [cscope([{ status: 'A', path: 'tests/test_skill_a.mjs' }]), cscope(M('tests/test_pass.mjs'))].map((x) => x.includes('test_scope_sections.mjs')), [true, true]);
  t('a change outside tests/ does not run them', cscope(M('desk/bin/lib.sh')).includes('test_scope_sections.mjs'), false);
}
t('a changed suite runs itself', scope(M('tests/test_docs.mjs')), 'some: test_docs.mjs test_lint.sh');
t('a shell change lists its scripts for bash 3.2', decide(M('desk/bin/lib.sh'), map).shells, ['bin/tool', 'desk/bin/drive.sh', 'desk/bin/lib.sh', 'tests/test_drive.sh', 'tests/test_lint.sh']);
t('README.md alone is a document', scope(M('README.md')), 'full: no suite claims README.md');
t('fail closed: a file no suite claims runs everything', scope(M('desk/bin/lone.mjs')), 'full: no suite claims desk/bin/lone.mjs');
t('fail closed: a new unclaimed file runs everything', scope([{ status: 'A', path: 'desk/bin/new.mjs' }]), 'full: no suite claims desk/bin/new.mjs');
t('fail closed: a claimed file beside an unclaimed one', scope(M('desk/bin/lib.sh', 'desk/bin/lone.mjs')), 'full: no suite claims desk/bin/lone.mjs');
t('tests/run.sh runs everything', scope(M('tests/run.sh')), 'full: tests/run.sh is shared by every suite');
t('a test helper no suite claims runs everything', scope(M('tests/helper.mjs')), 'full: no suite claims tests/helper.mjs');
t('a fixture no suite claims runs everything', scope(M('tests/fixtures/a.md')), 'full: no suite claims tests/fixtures/a.md');
t('desk-env.mjs runs everything', scope(M('desk/bin/desk-env.mjs')), 'full: desk/bin/desk-env.mjs is shared by every suite');
t('config-schema.mjs, the source of desk-env.mjs\'s id tables, runs everything', scope(M('desk/bin/config-schema.mjs')), 'full: desk/bin/config-schema.mjs is shared by every suite');
t('install.sh no suite claims runs everything', scope(M('install.sh')), 'full: no suite claims install.sh');
t('a workflow runs everything', scope(M('.github/workflows/tests.yml')), 'full: .github/workflows/tests.yml is shared by every suite');
t('a root file runs everything', scope(M('.gitignore')), 'full: .gitignore is a root file');
t('a deletion runs everything', scope([{ status: 'D', path: 'desk/bin/queue.mjs' }]), 'full: desk/bin/queue.mjs was deleted');
t('a rename runs everything', scope([{ status: 'R', path: 'desk/bin/q2.mjs', from: 'desk/bin/queue.mjs' }]), 'full: desk/bin/queue.mjs was renamed to desk/bin/q2.mjs');
t('a file many suites reach runs those suites, not everything', scope(M('desk/bin/lock.mjs')), 'some: test_data.mjs test_drive.sh test_lint.sh test_pass.mjs');
t('full runs every suite and checks every shell script', [decide(M('install.sh'), map).suites.length, decide(M('install.sh'), map).shells.length], [6, 7]);
// A suite that replays other suites claims them with a covers: glob, and nothing they name.
const replay = { ...tree, 'tests/test_replay.sh': '# suite: replay\n# covers: tests/test_d*.sh\nbash compare.sh' };
const rmap = buildMap(Object.keys(replay), (p) => replay[p]);
const rscope = (ch) => decide(ch, rmap).suites.join(' ');
t('DS-920 a covers: glob claims the suites it matches', [[...(rmap.claims.get('tests/test_drive.sh') ?? [])], [...(rmap.claims.get('tests/test_data.mjs') ?? [])], [...(rmap.claims.get('tests/test_pass.mjs') ?? [])]], [['test_replay.sh'], [], []]);
t('DS-920 a changed suite runs the suite that covers it', [rscope(M('tests/test_drive.sh')), rscope(M('tests/test_pass.mjs'))], ['test_drive.sh test_lint.sh test_replay.sh', 'test_lint.sh test_pass.mjs']);
t('DS-920 a covered suite does not pass on what it names', rscope(M('desk/bin/drive.sh')), 'test_drive.sh test_lint.sh');

// DS-986: with l3Direct (tests/related.sh), an L3 suite runs only for a change it claims directly; one it
// reaches only through imports is left for CI. test_e2e.sh names pass.mjs, which imports queue.mjs, which
// imports lock.mjs; test_e2e_lock.sh names lock.mjs. test_pass.mjs (L1) and test_drive.sh (L2) reach all three.
const layered = {
  ...tree,
  'tests/test_pass.mjs': "// suite: pass\n// layer: L1\nimport { run } from '../desk/bin/pass.mjs';",
  'tests/test_drive.sh': '# suite: drive\n# layer: L2\n"$SRC/desk/bin/drive.sh"\n"$SRC/bin/tool"\nnode "$SRC/desk/bin/pass.mjs"',
  'tests/test_e2e.sh': '# suite: e2e\n# layer: L3\nnode "$SRC/desk/bin/pass.mjs" --once',
  'tests/test_e2e_lock.sh': '# suite: e2e lock\n# layer: L3\nnode "$SRC/desk/bin/lock.mjs"',
};
const lmap = buildMap(Object.keys(layered), (p) => layered[p]);
const local = (ch) => { const d = decide(ch, lmap, { l3Direct: true }); return [d.scope, d.suites.join(' '), (d.ci ?? []).join(' ')]; };
t('DS-986 AC1 an L3 suite a change reaches only through imports does not run, and is left for CI', local(M('desk/bin/queue.mjs')), ['some', 'test_drive.sh test_lint.sh test_pass.mjs', 'test_e2e.sh']);
t('DS-986 AC1 the reason counts it', decide(M('desk/bin/queue.mjs'), lmap, { l3Direct: true }).reason, '1 changed file(s) reach 3 of 8 suites, and 1 L3 suite(s) only through imports, left for CI');
t('DS-986 AC1 one changed file one L3 suite claims directly, another it reaches through imports', local(M('desk/bin/lock.mjs')), ['some', 'test_data.mjs test_drive.sh test_e2e_lock.sh test_lint.sh test_pass.mjs', 'test_e2e.sh']);
t('DS-986 AC2 an L3 suite runs for a file it claims directly', local(M('desk/bin/pass.mjs')), ['some', 'test_drive.sh test_e2e.sh test_lint.sh test_pass.mjs', '']);
t('DS-986 AC2 and for a change to the suite itself', local(M('tests/test_e2e.sh')), ['some', 'test_e2e.sh test_lint.sh', '']);
t('DS-986 AC2 one direct claim among the changed files runs it, and it is not left for CI', local(M('desk/bin/queue.mjs', 'desk/bin/pass.mjs')), ['some', 'test_drive.sh test_e2e.sh test_lint.sh test_pass.mjs', '']);
t('DS-986 AC3 L1 and L2 suites reached through imports run as without l3Direct', [local(M('desk/bin/queue.mjs'))[1], decide(M('desk/bin/queue.mjs'), lmap).suites.filter((s) => !s.startsWith('test_e2e')).join(' ')], ['test_drive.sh test_lint.sh test_pass.mjs', 'test_drive.sh test_lint.sh test_pass.mjs']);
t('DS-986 AC4 a full scope runs every suite, L3 included', local(M('install.sh')), ['full', lmap.suites.map((s) => s.file).join(' '), '']);
t('DS-986 AC5 without l3Direct (CI) L3 suites are selected through imports as before, and nothing is left',
  [decide(M('desk/bin/queue.mjs'), lmap).suites.join(' '), 'ci' in decide(M('desk/bin/queue.mjs'), lmap), decide(M('desk/bin/queue.mjs'), lmap).reason],
  ['test_drive.sh test_e2e.sh test_lint.sh test_pass.mjs', false, '1 changed file(s) reach 4 of 8 suites']);
t('DS-986 direct claims are what a suite names or globs, before any load is followed', [[...(lmap.direct.get('desk/bin/pass.mjs') ?? [])].sort(), [...(lmap.direct.get('desk/bin/queue.mjs') ?? [])]], [['test_drive.sh', 'test_e2e.sh', 'test_pass.mjs'], []]);

// DS-818: root documents and scripts, and files under tests/ that are not suites, are claimed like any
// other file; desk-env.mjs gaining exports runs the suites that use them.
const claimed = {
  ...tree,
  'desk-config.md': '# config',
  'skills/writing/SKILL.md': '# writing',
  'tests/compare_pass.sh': '#!/usr/bin/env bash\nnode "$(dirname "$0")/compare_pass.mjs"',
  'tests/compare_pass.mjs': 'export {}',
  'tests/pass_setup.sh': 'setup() { :; }',
  'tests/prose_scan.mjs': 'export {}',
  'tests/fixtures/prose_baseline.json': '{}',
  'tests/test_install.sh': '# suite: install\nbash "$SRC/install.sh"',
  'tests/test_config.mjs': "// suite: config\nread(join(R, 'desk-config.md'))",
  'tests/test_compare.sh': '# suite: compare\nbash "$S/compare_pass.sh" main',
  'tests/test_pass_x.sh': '# suite: pass x\n. "$S/pass_setup.sh"',
  'tests/test_prose.mjs': "// suite: prose\n// covers: skills/writing/**\nimport { scan } from './prose_scan.mjs';\nread('tests/fixtures/prose_baseline.json')",
  'tests/test_env_user.mjs': "// suite: env user\nimport { newThing } from '../desk/bin/desk-env.mjs';",
  'tests/test_schema_user.mjs': "// suite: schema user\nimport { newRow } from '../desk/bin/config-schema.mjs';",
};
const cmap = buildMap(Object.keys(claimed), (p) => claimed[p]);
const cscope = (ch) => { const d = decide(ch, cmap); return `${d.scope}: ${d.scope === 'full' ? d.reason : d.suites.join(' ')}`; };
t('DS-818 AC4 desk-config.md runs the suites that claim it', cscope(M('desk-config.md')), 'some: test_config.mjs test_lint.sh');
t('DS-818 AC5 install.sh runs the suites that claim it', cscope(M('install.sh')), 'some: test_install.sh test_lint.sh');
t('DS-818 AC6 compare_pass.sh, compare_pass.mjs and pass_setup.sh run the suites that claim each', [cscope(M('tests/compare_pass.sh')), cscope(M('tests/compare_pass.mjs')), cscope(M('tests/pass_setup.sh'))], ['some: test_compare.sh test_lint.sh', 'some: test_compare.sh test_lint.sh', 'some: test_lint.sh test_pass_x.sh']);
t('DS-818 AC7 skill prose and the prose baseline run the prose suites', cscope(M('skills/writing/SKILL.md','tests/fixtures/prose_baseline.json', 'tests/prose_scan.mjs')), 'some: test_lint.sh test_prose.mjs');
t('DS-818 a root file that is not a document or a script still runs everything', cscope(M('.gitignore')), 'full: .gitignore is a root file');
t('DS-818 tests/run.sh and the scoping script stay foundational', [cscope(M('tests/run.sh')), cscope(M('tests/suite_env.sh')), cscope(M('tests/scope_sections.mjs'))].map((s) => s.split(':')[0]), ['full', 'full', 'full']);
const E = (exports) => [{ status: 'M', path: 'desk/bin/desk-env.mjs', exports }];
t('DS-818 AC2 desk-env.mjs gaining exports runs the suites that use them', [cscope(E(['newThing'])), cscope([...E(['newThing']), ...M('install.sh')])], ['some: test_env_user.mjs test_lint.sh', 'some: test_env_user.mjs test_install.sh test_lint.sh']);
t('DS-818 AC3 any other desk-env.mjs change runs everything', cscope(E(undefined)), 'full: desk/bin/desk-env.mjs is shared by every suite');
// config-schema.mjs takes the same exports-only rule, checked on the real module.
const schema = readFileSync(join(R, 'desk/bin/config-schema.mjs'), 'utf8');
const S = (after) => [{ status: 'M', path: 'desk/bin/config-schema.mjs', exports: addedExports(schema, after) ?? undefined }];
t('DS-976 AC1 config-schema.mjs gaining an export runs the suites that use it', cscope(S(`${schema}export const newRow = 1;\n`)), 'some: test_lint.sh test_schema_user.mjs');
t('DS-976 AC2 an edited config-schema.mjs export runs everything', cscope(S(schema.replace("export const EXTRA_MODELS = ['finder', 'text'];", "export const EXTRA_MODELS = ['finder', 'text', 'other'];"))), 'full: desk/bin/config-schema.mjs is shared by every suite');
t('DS-976 AC3 a removed config-schema.mjs export runs everything', cscope(S(schema.replace("export const LEVERS_AUTO = 'auto';\n", ''))), 'full: desk/bin/config-schema.mjs is shared by every suite');
const env = 'import { x } from "./y.mjs";\n\nexport const one = 1;\n\nexport function two(a) {\n  return a;\n}\n';
t('DS-818 addedExports: new exports, in any place, with comments', addedExports(env, 'import { x } from "./y.mjs";\n\nexport const one = 1;\n// three\nexport const three = (a) => a;\n\nexport function two(a) {\n  return a;\n}\n/** four */\nexport async function four() {}\nexport const FIVE = [\'a\'];\n'), ['three', 'four', 'FIVE']);
t('DS-818 addedExports: an unchanged module adds none', addedExports(env, env), []);
t('DS-818 addedExports: an edited, removed or reordered statement is not export-only', [
  addedExports(env, env.replace('return a', 'return a + 1')),
  addedExports(env, env.replace('export const one = 1;\n', '')),
  addedExports(env, 'import { x } from "./y.mjs";\n\nexport function two(a) {\n  return a;\n}\nexport const one = 1;\n'),
], [null, null, null]);
t('DS-818 addedExports: a new statement that is not an export, or runs code on load, is not export-only', [
  addedExports(env, `${env}function helper() {}\n`),
  addedExports(env, `${env}export const read = readFileSync('x');\n`),
  addedExports(env, `${env}export default 1;\n`),
  addedExports(env, `${env}main();\n`),
], [null, null, null, null]);
t('DS-818 addedExports: a class, a value that runs code without a call, or a second declarator is not export-only', [
  addedExports(env, `${env}export class Probe {\n  static { throw new Error('load'); }\n}\n`),
  addedExports(env, `${env}export class Probe extends make() {}\n`),
  addedExports(env, `${env}export class Plain {}\n`),
  addedExports(env, `${env}export const tag = String.raw\`x\`;\n`),
  addedExports(env, `${env}export const made = new Date;\n`),
  addedExports(env, `${env}export const early = later;\n`),
  addedExports(env, `${env}export const f = (a) => a, g = main();\n`),
  addedExports(env, `${env}export function f() {}; main();\n`),
  addedExports(env, `${env}export const f = () => 1\n  main();\n`),
  addedExports(env, `${env}export const iife = function () { main(); }();\n`),
  addedExports(env, `${env}export const arrowIife = (() => main())();\n`),
  addedExports(env, `${env}export function g() {} (main());\n`),
  addedExports(env, `${env}export function g() {} [main()];\n`),
  addedExports(env, `${env}export const n = (null)();\n`),
  addedExports(env, `${env}export const m = [][0]();\n`),
  addedExports(env, `${env}export const k = null[0];\n`),
  addedExports(env, `${env}export const s = ''['constructor']['constructor']('main()')();\n`),
  addedExports(env, `${env}export const d = 1..constructor.constructor('main()')();\n`),
  addedExports(env, `${env}export const spread = { ...other };\n`),
], Array(19).fill(null));
t('DS-818 fix try: a quote or slash in a regex, or a line break in a block comment, does not hide a statement', [
  addedExports(env, `${env}export function qzB() { return /'/; } main(); function qzB2() { return /'/; }\n`),
  addedExports(env, `${env}export const zzq = () => /\\//; main();\n`),
  addedExports(env, `${env}export const f = () => {} /*\n*/ throw new Error()\n`),
  addedExports(env, `${env}export const f2 = () => 1 /*\n  */ main()\n`),
  addedExports(env, `${env}export function g(a) { if (a) /'/.test(a) } main(); function h() { '/' }\n`),
  addedExports(env, `${env}export function g(a) { return a) /(/; main(); g(/)/ }\n`),
  addedExports(env, `${env}export const u = () => 'open\n';\n`),
  addedExports(env, `${env}export function qzA() { return \`\${"\`"}\`; } main(); export function qzB() { return \`\${"\`"}\`; }\n`),
  addedExports(env, `${env}export const qzC = () => \`\${"\`"}\`; main(); const qzD = () => \`\${"\`"}\`;\n`),
  addedExports(env, `${env}export const qzE = () => \`\${ {a: 1}.a }\`; main();\n`),
  addedExports(env, `${env}export const qzF = () => \`\${'\`'}\`; main(); // '\n`),
  addedExports(env, `${env}export const p1 = () => g++ / 1; main(); 1 / 2;\n`),
  addedExports(env, `${env}export const p2 = () => x.of / 1, y = main() / 2;\n`),
  addedExports(env, `${env}export const p3 = () => x.in / 1; main(); 1 / 2;\n`),
  addedExports(env, `${env}export const p5 = () => ({ return: 1 }).return / 2; throw Error('load'); //\n`),
  addedExports(env, `${env}export const p6 = () => {} /*   */ throw new Error('load');\n`),
  addedExports(env, `${env}/* doc */ throw new Error('load'); /* end */\nexport const p7 = 1;\n`),
  addedExports(env, `${env}// doc   main();\nexport const p8 = 1;\n`),
  addedExports(env, `${env}export const p9 = 1n + 1;\n`),
  addedExports(env, `${env}export function p10() {} <!-- x\n`),
  addedExports(env, `${env}export function proce\\u0073s() {}\n`),
  addedExports(env, `${env}export function th\\u0065n(resolve) { throw new Error('load'); }\n`),
  addedExports(env, `${env}export function then() {}\n`),
  addedExports(env, `${env}export const p11 = +1n;\n`),
  addedExports('const t = `\nhelp\n`;\nconsole.log(t);\n', 'const t = `\nexport const zq = 1\nhelp\n`;\nconsole.log(t);\n'),
  addedExports('const t = `\nhelp\n`;\nconsole.log(t);\n', 'const t = `\n// zq\nhelp\n`;\nconsole.log(t);\n'),
  addedExports('function g() {}\n(g)();\n', 'function g() {}\nexport const zq = 0\n(g)();\n'),
  addedExports('const x = 1\n+ 2;\n', 'const x = 1\nexport function zq() {}\n+ 2;\n'),
  addedExports(env, `${env}export const zzA = /*x*/dgimsuy;\n`),
  addedExports(env, env.replace('export function two', 'export const zzA = /*x*/\nexport function two')),
  addedExports(env, `${env}export const zzA = /*a/\nexport const zzB = /b*/d;\n`),
], Array(31).fill(null));
t('DS-818 fix try: a shebang, imports and import.meta in the old module still let a new export count', addedExports('#!/usr/bin/env node\nimport { a } from "./a.mjs";\nexport const here = import.meta.url;\n', '#!/usr/bin/env node\nimport { a } from "./a.mjs";\nexport const here = import.meta.url;\nexport function zq() {}\n'), ['zq']);
t('DS-818 fix try: a slash JavaScript reads as a regex counts as one', addedExports(env, `${env}export const p4 = () => a + /x; main(); 1/;\n`), ['p4']);
t('DS-818 fix try: a regex with , or ; in a class or a {n,m}, and a / after a postfix ++ or a .property, still count', addedExports(env, `${env}export const SEP = /[,;]\\d{1,3}/;\nexport const sep = (s) => s.split(/[,;]+/);\nexport function step(i, o) {\n  i++ / 2;\n  return o.in / 2;\n}\n`), ['SEP', 'sep', 'step']);
t('DS-818 fix try: a template with substitutions in a body still counts', addedExports(env, `${env}export const label = (a, b) => \`\${a}: \${ {x: b}.x } \${\`in \${b}\`}\`;\nexport function say(n) {\n  return \`\${n} \${n === 1 ? 'item' : 'items'}\`;\n}\n`), ['label', 'say']);
t('DS-818 fix try: an arrow body going on over lines that start with . or ?. counts, and a regex or division in a body is read', addedExports(env, `${env}export const kills = (dmesg) => String(dmesg).split('\\n').filter((l) => /out of memory: Killed process/i.test(l))\n  .map((l) => { const m = /^\\[\\s*(\\d+(?:\\.\\d+)?)\\]/.exec(l); return m ? Number(m[1]) : l.trim(); });\nexport const opt = (a) => a\n  ?.b\n  .c;\nexport function half(a, b) {\n  return (a + b) / 2 / a;\n}\nexport const slash = () => /[/'"]/g;\n`), ['kills', 'opt', 'half', 'slash']);
t('DS-818 fix try: a line that does not start with . or ?. still ends the arrow', [
  addedExports(env, `${env}export const w = (a) => a\n  .b\nmain();\n`),
  addedExports(env, `${env}export const w2 = (a) => a\n  ...b;\n`),
], [null, null]);
t('DS-818 addedExports: a new name that shadows a global or a name the module already uses is not export-only', [
  addedExports(env, `${env}export function fetch() {}\n`),
  addedExports(env, `${env}export const URL = 'x';\n`),
  addedExports(`${env}export function usesY() {\n  return y;\n}\n`, `${env}export function usesY() {\n  return y;\n}\nexport const y = 2;\n`),
], [null, null, null]);
t('DS-818 addedExports: literal values, multi-line function bodies and arrows still count', addedExports(env, `${env}export const LIMITS = { max: 3, names: ['a', "b"], on: true, off: null, n: -1.5 };\nexport function g(a = 1) {\n  if (a) { return [a]; }\n  return null;\n}\nexport const h = async (x) => {\n  return x;\n};\n`), ['LIMITS', 'g', 'h']);
t('DS-818 addedExports: an arrow with a default that calls, a body on the next line, and a regex count too', addedExports(env, `${env}export const dir = (slug = current().slug) => (slug ? join(slug) : null);\nexport const wrap = (a) =>\n  a.map((x) => x + 1);\nexport const SHOT = /\\.(png|jpe?g)$/i;\nexport const fe = function named(a) {\n  return a; // it's fine\n};\n`), ['dir', 'wrap', 'SHOT', 'fe']);

// ---- this repo -----------------------------------------------------------------------------------
const real = repoMap(R);
// The real desk-env.mjs (a shebang, imports, import.meta, and top-level await in its CLI block).
const envReal = readFileSync(join(R, 'desk/bin/desk-env.mjs'), 'utf8');
t('DS-818 AC2 on the real desk-env.mjs: an export at the end, and one beside oomKills, count', [
  addedExports(envReal, `${envReal}export function zqDs818End() {}\n`),
  addedExports(envReal, envReal.replace('export const oomKills', 'export const zqDs818Mid = (a) => a\n  .map((x) => x);\nexport const oomKills')),
], [['zqDs818End'], ['zqDs818Mid']]);
const listed = execFileSync('git', ['-C', R, 'ls-files', 'tests/test_*.sh', 'tests/test_*.mjs'], { encoding: 'utf8' }).trim().split('\n').map((f) => f.slice(6)).sort();
t('every suite in the repo is in the map', real.suites.map((s) => s.file).sort(), listed);
t('this suite and its script are foundational', [decide(M('tests/scope_sections.mjs'), real).scope, decide(M('tests/bash32_check.sh'), real).scope], ['full', 'full']);
// Regressions from review: a script pass.mjs launches reaches the end-to-end batch suite, or runs all.
for (const f of ['desk/bin/base-gate.mjs', 'desk/bin/with-lock.sh']) {
  const d = decide(M(f), real);
  t(`${f} selects test_batch_e2e.sh or runs everything`, d.scope === 'full' || d.suites.includes('test_batch_e2e.sh'), true);
}
t('a suite with claims: imports claims nothing it only names, only what it imports', [...real.claims].filter(([, s]) => s.has('test_scope_sections.mjs')).map(([p]) => p).sort(), ['tests/scope_sections.mjs', 'tests/scratch.mjs']);
// A suite that walks the repo tree must say what it reads with a covers: line, or what it reads is unclaimed.
const walks = /\b(readdirSync|readdir|walk|markdownFiles)\s*\(\s*(\[?\s*join\(\s*(root|R|ROOT|SRC)\b|refs\b|skill\b)|git ls-files/;
const uncovered = real.suites.filter((s) => !ALWAYS.includes(s.file) && !s.importsOnly && !s.covers.length && walks.test(readFileSync(join(R, 'tests', s.file), 'utf8'))).map((s) => s.file);
t('every suite that walks the repo tree has a covers: line', uncovered, []);
// Each suite's test layer: L1 in process, L2 one process boundary, L3 end to end.
t('DS-985 AC1 every suite in the repo declares exactly one layer, L1, L2 or L3', real.suites.filter((s) => !LAYERS.includes(s.layer)).map((s) => s.file), []);
t('DS-985 AC1 a second layer line, an unknown layer or none is no layer', ['// suite: x\n// layer: L1\n// layer: L2\n', '# suite: x\n# layer: L4\n', '# suite: x\n', '# suite: x\n# layer: L2\n'].map((h) => suiteHeader(h).layer), [null, null, null, 'L2']);
const textOf = (p) => { try { return readFileSync(join(R, p), 'utf8'); } catch { return ''; } };
const layerOf = (f) => real.suites.find((s) => s.file === f)?.layer;
// End to end: the suites built on the pass, batch and merge driver setups, and those running the real
// pass.mjs or merge-driver.sh themselves. A claims: imports suite's text is test data, so it is not read
// for this.
const endToEnd = real.suites.filter((s) => !s.importsOnly).map((s) => s.file).filter((f) => /^\s*(source|\.) .*(pass_setup|batch_e2e_setup|merge_driver_setup|base_sync_setup)\.sh/m.test(textOf(`tests/${f}`)) || /node "\$B\/pass\.mjs"|join\(BIN, 'pass\.mjs'\)|bash "\$B\/merge-driver\.sh" --tickets/.test(textOf(`tests/${f}`)));
t('DS-985 AC3 a suite that runs a pass, batch or merge driver end to end is L3', endToEnd.filter((f) => layerOf(f) !== 'L3'), []);
t('DS-985 AC3 those include the pass, batch, merge driver and installer suites', ['test_pass_spawns.sh', 'test_batch_e2e.sh', 'test_merge_driver_loop.sh', 'test_epic.sh', 'test_install_skips.sh'].map(layerOf), ['L3', 'L3', 'L3', 'L3', 'L3']);
// In process: a .mjs suite that, with the tests/ helpers it imports, never loads child_process (the
// pass-phase trap loads it only to refuse every call) and writes no executable stub, which is there only
// for the module under test to start.
const startsNothing = (p) => !/child_process|(chmodSync\(.*|mode: )0o7[57][57]\b/.test(textOf(p));
const inProcess = (f) => f.endsWith('.mjs') && importClosure(`tests/${f}`, textOf).filter((p) => p.startsWith('tests/') && p !== 'tests/pass_phase_trap.mjs').every(startsNothing);
t('DS-985 AC4 a suite whose cases import modules and start no process is L1', real.suites.map((s) => s.file).filter((f) => inProcess(f) && layerOf(f) !== 'L1'), []);
t('DS-985 AC4 and an L1 suite starts no process', real.suites.filter((s) => s.layer === 'L1' && !inProcess(s.file)).map((s) => s.file), []);
const cw = decide(M('desk/bin/clears-when.mjs'), real);
t('clears-when.mjs, reached through queue.mjs, runs the suites that claim it', [cw.scope, cw.suites], ['some', real.suites.map((s) => s.file).filter((s) => ALWAYS.includes(s) || real.claims.get('desk/bin/clears-when.mjs')?.has(s))]);
// A script no suite names is unclaimed, and changing it runs everything: each of these has a claim.
for (const [f, suite] of [['desk/bin/github-signin.mjs', 'test_playwright.mjs'],
  ...['claude_activity.py', 'desk_repos.py', 'github_activity.py', 'jira_activity.py', 'window.py'].map((s) => [`skills/desk-checkout/scripts/${s}`, 'test_checkout.mjs'])]) {
  const d = decide(M(f), real);
  t(`${f} runs ${suite}, not everything`, [d.scope, d.suites.includes(suite)], ['some', true]);
}
t('DS-920 AC4 a changed pass suite runs test_compare_pass.sh', ['test_pass_other_repo.sh', 'test_pass_spawns.sh'].map((s) => decide(M(`tests/${s}`), real).suites.includes('test_compare_pass.sh')), [true, true]);
const MERGE_DRIVER_SUITES = ['loop', 'reruns', 'approval', 'holds', 'review', 'tree'].map((s) => `test_merge_driver_${s}.sh`);
t('merge-driver.sh reaches every merge driver suite', MERGE_DRIVER_SUITES.filter((s) => !decide(M('desk/bin/merge-driver.sh'), real).suites.includes(s)), []);
// A helper that L1 suites import decides their layer, so changing it runs the check on every test file.
{ const d = decide(M('tests/prose_check.mjs'), real); t('a helper L1 suites import runs the checks on every test file', [d.scope, d.suites.includes('test_scope_sections.mjs')], ['some', true]); }
// DS-818 AC4 to AC6 on this repo: each runs the suites that claim it, not every suite.
for (const f of ['desk-config.md', 'install.sh', 'tests/compare_pass.sh', 'tests/compare_pass.mjs', 'tests/pass_setup.sh']) {
  const d = decide(M(f), real);
  t(`DS-818 ${f} runs the suites that claim it`, [d.scope, d.suites], ['some', real.suites.map((s) => s.file).filter((s) => ALWAYS.includes(s) || real.claims.get(f)?.has(s) || (f.startsWith('tests/') && s === 'test_scope_sections.mjs'))]);
}
// DS-884 AC5: a change only to a module the prose check imports, directly or through another, runs it.
const proseCovers = real.suites.find((s) => s.file === 'test_prose_code.mjs').covers.filter((p) => /\.mjs$/.test(p) && !p.includes('*'));
t('DS-884 AC5 each module on the prose check\'s covers lines runs the prose check',
  proseCovers.filter((p) => !decide(M(p), real).suites.includes('test_prose_code.mjs')), []);
t('DS-884 AC5 machine.mjs, which the prose facts registry reaches only through desk-env.mjs, runs the prose check without running everything',
  [decide(M('desk/bin/machine.mjs'), real).scope, decide(M('desk/bin/machine.mjs'), real).suites.includes('test_prose_code.mjs')], ['some', true]);
t('a desk-pr reference reaches the desk-pr split suite', decide(M('skills/desk-pr/references/opening.md'), real).suites.includes('test_desk_pr_split.mjs'), true);
const cli = spawnSync(process.execPath, [join(R, 'tests/scope_sections.mjs'), '--files', 'desk/bin/merge-driver.sh', '--json'], { encoding: 'utf8' });
const j = JSON.parse(cli.stdout || '{}');
t('cli --files --json', [cli.status, j.scope, j.suites?.includes('test_merge_driver_loop.sh'), j.shells?.includes('desk/bin/merge-driver.sh')], [0, 'some', true, true]);
// DS-986 on this repo: what related.sh leaves for CI is L3, and with what it runs makes CI's selection.
for (const f of ['desk/bin/clears-when.mjs', 'desk/bin/queue.mjs']) {
  const ci = decide(M(f), real), loc = decide(M(f), real, { l3Direct: true });
  t(`DS-986 ${f}: related.sh leaves only L3 suites for CI, and runs the rest of CI's selection`,
    [loc.ci.length > 0, loc.ci.filter((s) => layerOf(s) !== 'L3'), [...loc.suites, ...loc.ci].sort().join(' ') === [...ci.suites].sort().join(' ')], [true, [], true]);
}
const lcli = spawnSync(process.execPath, [join(R, 'tests/scope_sections.mjs'), '--files', 'desk/bin/queue.mjs', '--l3-direct', '--json'], { encoding: 'utf8' });
const lj = JSON.parse(lcli.stdout || '{}');
t('DS-986 cli --l3-direct --json names the suites left for CI', [lcli.status, Array.isArray(lj.ci) && lj.ci.length > 0, lj.ci?.some((s) => lj.suites.includes(s))], [0, true, false]);

// DS-999: with byName (tests/related.sh), an edit to named functions of desk-env.mjs or config-schema.mjs
// runs the suites reaching them; CI, without it, still runs every suite. The diffs are real merged edits,
// undone on the current module: to linuxMeminfo, to repoPlacement (with the repoDirs it added), and to
// machineValue (with a line in the command line's `machine` case).
const N = (path, before, after) => [{ status: 'M', path, names: changedNames(before, after) }];
const byName = (ch) => decide(ch, real, { l3Direct: true, byName: true });
const shown = (d) => [d.scope, d.scope === 'full' ? d.reason : d.suites.length < real.suites.length];
const meminfoOld = envReal.replace("    const m = M.parseMeminfo(readFileSync('/proc/meminfo', 'utf8'));", "    const m = {};\n    for (const l of readFileSync('/proc/meminfo', 'utf8').split('\\n')) {\n      const x = /^(\\w+):\\s+(\\d+)/.exec(l);\n      if (x) m[x[1]] = Number(x[2]) * 1024;\n    }");
const mem = byName(N('desk/bin/desk-env.mjs', meminfoOld, envReal));
t('DS-999 AC1 an edit to linuxMeminfo\'s body runs the suites reaching it, not every suite', [shown(mem), changedNames(meminfoOld, envReal)], [['some', true], { names: ['linuxMeminfo'] }]);
t('DS-999 AC1 they include a suite running the `desk-env mem` command it serves', mem.suites.includes('test_test_scope.mjs'), true);
const dirsAt = envReal.indexOf('// A configured repo\'s directories from its own config');
const dirsEnd = envReal.indexOf('\n}\n', dirsAt) + 3;
const placementOld = (envReal.slice(0, dirsAt) + envReal.slice(dirsEnd)).replace('root: repoDirs(hits[0].slug, root).root, otherName };', "root: dir && !isNone(dir) ? expandHome(dir) : null, otherName };")
  .replace('  return { repository, slug: hits[0].slug', "  const dir = String(repoConfigValue(hits[0].slug, 'repo-root', root) ?? '').trim();\n  return { repository, slug: hits[0].slug");
t('DS-999 AC1 an edited function and a new one beside it narrow on both', changedNames(placementOld, envReal), { names: ['repoPlacement', 'repoDirs'] });
t('DS-999 AC1 and run the suites reaching them', shown(byName(N('desk/bin/desk-env.mjs', placementOld, envReal))), ['some', true]);
const machineOld = envReal.replace('  const v = M.profileValue(machineProfile(), key);', '  const p = machineProfile();\n  const v = p?.sizing[key]?.value ?? p?.hardware[key]?.value;');
t('DS-999 AC1 machineValue\'s edit is full: PATHS, built on load, names repoRoot, which reaches it', shown(byName(N('desk/bin/desk-env.mjs', machineOld, envReal))),
  ['full', 'desk/bin/desk-env.mjs is shared by every suite, and the change is not narrowed by name: desk/bin/desk-env.mjs runs one at load: const PATHS = { (repoRoot)']);
const cliLine = '          for (const w of M.sizingWarnings(M.rewrittenSizing(profile, proposal), hw)) console.log(`\\nwarning: ${w}`);\n';
t('DS-999 AC2 an edit to the command line, module-level code, is full', byName(N('desk/bin/desk-env.mjs', envReal.replace(cliLine, ''), envReal)).reason,
  'desk/bin/desk-env.mjs is shared by every suite, and the change is not narrowed by name: a top-level statement that runs code when the module loads changed: if (isMain) {');
t('DS-999 AC2 so is an edited top-level call, a class, or a constant a call sets on load', [
  changedNames('export const a = 1;\nsetup();\n', 'export const a = 1;\nsetup(2);\n').full,
  changedNames('export class A {}\n', 'export class A { x() {} }\n').full,
  changedNames('export const P = read(1);\n', 'export const P = read(2);\n').full,
], ['a top-level statement that runs code when the module loads changed: setup(2);', 'a top-level statement that runs code when the module loads changed: export class A { x() {} }',
  'a top-level statement that runs code when the module loads changed: export const P = read(2);']);
t('DS-999 AC2 and DEFAULT_BROWSER_PROFILE\'s initializer in desk-env.mjs, which runs on every import', byName(N('desk/bin/desk-env.mjs', envReal, envReal.replace("expandHome(rowDefault('browser-profile'))", "expandHome(rowDefault('browser-profiles'))"))).scope, 'full');
const rowDefaultOld = envReal.replace('const rowDefault = (id) => ROWS.find((e) => e.id === id).default;', 'const rowDefault = (id) => ROWS.find((e) => e.id === id)?.default;');
t('DS-999 AC2 and a function such an initializer calls: rowDefault, run on load for DEFAULT_BROWSER_PROFILE', [rowDefaultOld !== envReal, changedNames(rowDefaultOld, envReal).names, byName(N('desk/bin/desk-env.mjs', rowDefaultOld, envReal)).reason.includes('runs one at load')],
  [true, ['rowDefault'], true]);
t('DS-999 AC2 and a function the command line runs before its switch', byName(N('desk/bin/desk-env.mjs', envReal.replace('const pinConfig = () => { pinned = true; };', 'const pinConfig = () => { pinned = !false; };'), envReal)).reason.endsWith('runs one at load: if (isMain) { (pinConfig)'), true);
t('DS-999 AC3 a removed, renamed or unexported name is full', [
  changedNames(envReal, envReal.replace(/\bexport function repoDirs\(/, 'export function repoDirectories(')).full,
  changedNames(envReal, envReal.replace(/\bexport function repoDirs\(/, 'function repoDirs(')).full,
  changedNames(schema, schema.replace("export const LEVERS_AUTO = 'auto';\n", '')).full,
], ['repoDirs was removed or renamed', 'repoDirs is no longer exported', 'LEVERS_AUTO was removed or renamed']);
t('DS-999 AC3 and its scope says why', byName(N('desk/bin/desk-env.mjs', envReal, envReal.replace(/\bexport function repoDirs\(/, 'function repoDirs('))).reason,
  'desk/bin/desk-env.mjs is shared by every suite, and the change is not narrowed by name: repoDirs is no longer exported');
t('DS-999 AC4 without byName (CI) the same edit runs every suite', [decide(N('desk/bin/desk-env.mjs', meminfoOld, envReal), real).scope, decide(N('desk/bin/desk-env.mjs', meminfoOld, envReal), real, { l3Direct: true }).scope], ['full', 'full']);
const forcedOld = schema.replace('export function forcedRows(read) {\n  const out = [];\n', 'export function forcedRows(read) {\n  const out = [];\n  if (!read) return out;\n');
t('DS-999 AC5 an edit to a config-schema.mjs function runs the suites reaching it, through desk-env.mjs too, not every suite', [changedNames(forcedOld, schema), shown(byName(N('desk/bin/config-schema.mjs', forcedOld, schema)))], [{ names: ['forcedRows'] }, ['some', true]]);
t('DS-999 AC5 one TYPES, built on load, reaches is full',byName(N('desk/bin/config-schema.mjs', schema.replace('  if (items == null || isNone(items)) return null;\n  const one', '  if (items == null || isNone(items)) return null;\n  if (!items.length) return undefined;\n  const one'), schema)).reason,
  'desk/bin/config-schema.mjs is shared by every suite, and the change is not narrowed by name: desk/bin/config-schema.mjs runs one at load: export const TYPES = Object.freeze({ (gitAuthorOf)');
t('DS-999 AC6 the reason names the changed functions', [mem.reason.endsWith(', narrowed on the changed names in desk/bin/desk-env.mjs: linuxMeminfo'), mem.narrowed], [true, ['desk/bin/desk-env.mjs: linuxMeminfo']]);
t('DS-999 a comment-only change narrows on nothing', changedNames(envReal, envReal.replace('// ---- CLI ---', '// ---- the CLI ---')), { names: [] });
t('DS-999 a new helper that runs code on load, or an edit that does not stand alone, is full', [
  changedNames('export const a = 1;\n', 'export const a = 1;\nconst b = read();\n').full,
  changedNames('export function f() {}\nexport const a = 1;\n', 'export function f() {} main();\nexport const a = 1;\n').full,
  changedNames('export const f = () => 1;\nexport const a = 1;\n', 'export const f = () => 1\n(main)();\nexport const a = 1;\n').full,
  changedNames('export function f() {}\nexport function g() {}\n', 'export function g() {}\nexport function f() {}\n').full,
  changedNames('export const a = 1;\n', 'export const a = 1;\nlet b = 2;\n').full,
], ['a top-level statement that runs code when the module loads changed: const b = read();', 'a top-level statement that runs code when the module loads changed: export function f() {} main();', 'f does not stand alone', 'g moved',
  'the new b is a let, or a name already in use']);
// DS-1003: a constant set by Object.freeze of a literal only holds data, so an edit to it narrows by name.
const leversOld = schema.replace("'review-reuse', 'wrappers']);", "'review-reuse']);");
const levers = byName(N('desk/bin/config-schema.mjs', leversOld, schema));
// AC1: adding a lever reads as an edit to LEVERS by name, not as load-time code,
// but TYPES, built on load, reaches LEVERS (through leverRow), so the real edit stays full and the reason says why.
t('DS-1003 AC1 adding a lever to LEVERS is an edit to LEVERS by name', [leversOld !== schema, changedNames(leversOld, schema)], [true, { names: ['LEVERS'] }]);
t('DS-1003 AC1 and is full because TYPES, built on load, reaches LEVERS', shown(levers),
  ['full', 'desk/bin/config-schema.mjs is shared by every suite, and the change is not narrowed by name: desk/bin/config-schema.mjs runs one at load: export const TYPES = Object.freeze({ (leverRow)']);
t('DS-1003 AC2 a frozen array or object of literals narrows as AC1 does', [
  changedNames("export const A = Object.freeze(['a', 1, true, null]);\n", "export const A = Object.freeze(['a', 2, false, null, 'b']);\n"),
  changedNames("export const O = Object.freeze({ a: 'x', b: [1, { c: null }] });\n", "export const O = Object.freeze({ a: 'y', b: [1, { c: -2 }], d: true });\n"),
  changedNames("export const A = Object.freeze(['a']);\nexport const b = 1;\n", "export const A = Object.freeze([\n  'a',\n  'b',\n]);\nexport const b = 1;\n"),
], [{ names: ['A'] }, { names: ['O'] }, { names: ['A'] }]);
const code = (s) => `a top-level statement that runs code when the module loads changed: ${s}`;
t('DS-1003 AC3 Object.freeze of a spread, a call or a reference is full, as today', [
  changedNames("export const A = Object.freeze(['a']);\n", "export const A = Object.freeze(['a', ...B]);\n").full,
  changedNames("export const A = Object.freeze(['a']);\n", "export const A = Object.freeze(['a', f()]);\n").full,
  changedNames("export const A = Object.freeze({ a: 1 });\n", "export const A = Object.freeze({ a: B });\n").full,
  changedNames("export const A = Object.freeze(['a']);\n", "export const A = Object.freeze(['a']).map(f);\n").full,
  changedNames("export const A = Object.freeze(['a']);\n", "export const A = Object.freeze(['a']), b = f();\n").full,
], [code("export const A = Object.freeze(['a', ...B]);"), code("export const A = Object.freeze(['a', f()]);"), code('export const A = Object.freeze({ a: B });'),
  code("export const A = Object.freeze(['a']).map(f);"), code("export const A = Object.freeze(['a']), b = f();")]);
t('DS-1003 AC4 any other call setting a constant is full, as today', [
  changedNames("export const A = Object.seal(['a']);\n", "export const A = Object.seal(['a', 'b']);\n").full,
  changedNames("export const A = freeze(['a']);\n", "export const A = freeze(['a', 'b']);\n").full,
], [code("export const A = Object.seal(['a', 'b']);"), code("export const A = freeze(['a', 'b']);")]);
t('DS-1003 AC5 without byName (CI) the LEVERS edit runs every suite', [decide(N('desk/bin/config-schema.mjs', leversOld, schema), real).scope, decide(N('desk/bin/config-schema.mjs', leversOld, schema), real, { l3Direct: true }).scope], ['full', 'full']);
// A made-up desk-env.mjs: helper() is reached through used(), forCmd() only through two commands of its
// command line, forAll() before its switch, and alone() by a suite naming it.
const cliEnv = `import { readFileSync } from 'node:fs';
function helper(a) {
  return a + 1;
}
export function used(a) {
  return helper(a);
}
export function alone() {
  return 1;
}
export function forCmd() {
  return 2;
}
export function forAll() {
  return 3;
}
const isMain = process.argv[1] === 'x';
if (isMain) {
  const [cmd] = process.argv.slice(2);
  forAll();
  switch (cmd) {
    case 'one':
    case 'uno': {
      console.log(forCmd());
      break;
    }
    case 'two':
      console.log(readFileSync('x'));
      break;
    default:
      process.exit(2);
  }
}
`;
const named = {
  'desk/bin/desk-env.mjs': cliEnv,
  'desk/bin/user.mjs': "import { used } from './desk-env.mjs';\nexport const u = () => used(1);",
  'desk/bin/caller.sh': '#!/usr/bin/env bash\ndesk-env uno',
  'desk/bin/other.sh': '#!/usr/bin/env bash\ndesk-env two',
  'tests/test_lint.sh': '# suite: lint\n# covers: **',
  'tests/test_user.mjs': "// suite: user\nimport { u } from '../desk/bin/user.mjs';",
  'tests/test_caller.sh': '# suite: caller\nbash "$SRC/desk/bin/caller.sh"',
  'tests/test_other.sh': '# suite: other\nbash "$SRC/desk/bin/other.sh"',
  'tests/test_alone.mjs': "// suite: alone\nimport { alone } from '../desk/bin/desk-env.mjs';",
};
const nmap = buildMap(Object.keys(named), (p) => named[p]);
const edit = (fn) => { const after = cliEnv.replace(new RegExp(`(function ${fn}\\(a?\\) \\{\\n  return )`), '$1-1 + 1 + '); const d = decide(N('desk/bin/desk-env.mjs', cliEnv, after), nmap, { byName: true }); return `${d.scope}: ${d.scope === 'full' ? d.reason : d.suites.join(' ')}`; };
t('DS-999 a helper runs the suites claiming the scripts that import and use what calls it', edit('helper'), 'some: test_lint.sh test_user.mjs');
t('DS-999 an export a suite imports runs that suite', edit('alone'), 'some: test_alone.mjs test_lint.sh');
t('DS-999 a function only some commands run runs the suites claiming a script naming one', edit('forCmd'), 'some: test_caller.sh test_lint.sh');
t('DS-999 a function every command runs is full', edit('forAll'), 'full: desk/bin/desk-env.mjs is shared by every suite, and the change is not narrowed by name: desk/bin/desk-env.mjs runs one at load: if (isMain) { (forAll)');
const runNamed = { ...named, 'tests/run.sh': '#!/usr/bin/env bash\ndesk-env one' };
const runMap = buildMap(Object.keys(runNamed), (p) => runNamed[p]);
t('DS-999 a function a command tests/run.sh runs reaches is full', decide(N('desk/bin/desk-env.mjs', cliEnv, cliEnv.replace('function forCmd() {\n  return ', 'function forCmd() {\n  return -1 + 1 + ')), runMap, { byName: true }).reason,
  'desk/bin/desk-env.mjs is shared by every suite, and the change is not narrowed by name: tests/run.sh, shared by every suite, may run `desk-env one`');
// DS-1002: with byName, an edit to named functions of any other desk/bin/ .mjs module runs the suites
// claiming it that reach those names; anything narrow() cannot follow runs every suite claiming it, as
// CI does. A made-up desk-q.mjs: rows() through a helper, keys() alone, wide() used through a namespace
// import, boot() run on load, and draw() run only as a command, which q-run.sh launches.
const hubQ = `import { lock } from './lock.mjs';
import { fileURLToPath } from 'node:url';
function fmt(a) {
  return String(a);
}
export function rows(a) {
  return fmt(a);
}
export function keys(a) {
  return [a];
}
export function wide() {
  return 1;
}
export function boot() {
  return lock;
}
const STARTED = boot();
function draw() {
  return 'q';
}
const isMain = (() => {
  try { return process.argv[1] === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) console.log(draw());
`;
const hub = {
  ...tree,
  'desk/bin/desk-q.mjs': hubQ,
  'desk/bin/needs.mjs': "import { rows } from './desk-q.mjs';\nexport const need = () => rows(1);",
  'desk/bin/pass.mjs': "import { keys } from './desk-q.mjs';\nexport const run = () => keys(1);",
  'desk/bin/ns.mjs': "import * as Q from './desk-q.mjs';\nexport const nsUse = () => Q.wide();",
  'desk/bin/with-lock.sh': '#!/usr/bin/env bash\nexec "$@"',
  'tests/test_needs.mjs': "// suite: needs\nimport { need } from '../desk/bin/needs.mjs';",
  'tests/test_pass.mjs': "// suite: pass\nimport { run } from '../desk/bin/pass.mjs';",
  'tests/test_ns.mjs': "// suite: ns\nimport { nsUse } from '../desk/bin/ns.mjs';",
  'tests/test_q.mjs': "// suite: q\nimport { rows } from '../desk/bin/desk-q.mjs';",
  'tests/test_lock.sh': '# suite: lock\n"$SRC/desk/bin/with-lock.sh" true',
  'desk/bin/q-run.sh': '#!/usr/bin/env bash\nnode "$B/desk-q.mjs" "$@"',
  'tests/test_cli.sh': '# suite: cli\n"$SRC/desk/bin/q-run.sh"',
};
delete hub['tests/test_drive.sh'];
const hmap = buildMap(Object.keys(hub), (p) => hub[p]);
// The made-up repo with these files changed.
const hubWith = (over) => { const h = { ...hub, ...over }; return buildMap(Object.keys(h), (p) => h[p]); };
const Q = (after) => [{ status: 'M', path: 'desk/bin/desk-q.mjs', names: changedNames(hubQ, after) }];
const hscope = (ch, map = hmap, opts = { l3Direct: true, byName: true }) => { const d = decide(ch, map, opts); return `${d.scope}: ${d.suites.join(' ')}`; };
const everyClaimer = `some: ${['test_lint.sh', ...hmap.claims.get('desk/bin/desk-q.mjs')].sort().join(' ')}`;
const keysEdit = hubQ.replace('return [a];', 'return [a, a];');
t('DS-1002 the made-up desk-q.mjs is claimed by every suite importing it or a script that does', everyClaimer, 'some: test_cli.sh test_lint.sh test_needs.mjs test_ns.mjs test_pass.mjs test_q.mjs');
t('DS-1002 a function only the module\'s command line runs runs the suites claiming a script launching it', hscope(Q(hubQ.replace("return 'q';", "return 'r';"))), 'some: test_cli.sh test_lint.sh');
t('DS-1002 but with an else, or a negated test, that code runs on import too, and every suite reaching the module runs', [
  hubQ.replace('if (isMain) console.log(draw());', 'if (isMain) console.log(draw()); else draw();'),
  hubQ.replace('if (isMain) console.log(draw());', 'if (isMain) {\n  if (process.argv[2]) console.log(1);\n  else console.log(draw());\n} else draw();'),
  hubQ.replace('process.argv[1] === fileURLToPath', 'process.argv[1] !== fileURLToPath'),
].map((q) => hscope([{ status: 'M', path: 'desk/bin/desk-q.mjs', names: changedNames(q, q.replace("return 'q';", "return 'r';")) }], hubWith({ 'desk/bin/desk-q.mjs': q })) === everyClaimer), [true, true, true]);
const blockQ = hubQ.replace('if (isMain) console.log(draw());', 'if (isMain) {\n  if (process.argv[2]) console.log(1);\n  else console.log(draw());\n}');
t('DS-1002 an else inside the command line\'s own block keeps it command-only', hscope([{ status: 'M', path: 'desk/bin/desk-q.mjs', names: changedNames(blockQ, blockQ.replace("return 'q';", "return 'r';")) }], hubWith({ 'desk/bin/desk-q.mjs': blockQ })), 'some: test_cli.sh test_lint.sh');
t('DS-1002 AC1 an edit to one exported function runs only the suites loading the module and naming it', hscope(Q(keysEdit)), 'some: test_lint.sh test_pass.mjs');
t('DS-1002 AC1 the reason says it was narrowed on that name', [decide(Q(keysEdit), hmap, { byName: true }).reason.endsWith(', narrowed on the changed names in desk/bin/desk-q.mjs: keys'), decide(Q(keysEdit), hmap, { byName: true }).narrowed], [true, ['desk/bin/desk-q.mjs: keys']]);
t('DS-1002 AC1 a helper runs the suites naming what calls it, directly or through a script', hscope(Q(hubQ.replace('return String(a);', 'return `${a}`;'))), 'some: test_lint.sh test_needs.mjs test_q.mjs');
t('DS-1002 AC2 an edited top-level statement that runs on load runs every suite reaching the module', [hscope(Q(hubQ.replace('const STARTED = boot();', 'const STARTED = boot() || 1;'))), hscope(Q(hubQ.replace('return lock;', 'return lock + 0;')))], [everyClaimer, everyClaimer]);
t('DS-1002 AC2 and the reason says why it was not narrowed', decide(Q(hubQ.replace('return lock;', 'return lock + 0;')), hmap, { byName: true }).reason.endsWith('not narrowed by name in desk/bin/desk-q.mjs (desk/bin/desk-q.mjs runs one at load: const STARTED = boot(); (boot))'), true);
t('DS-1002 AC3 a removed or renamed export runs every suite reaching the module', [hscope(Q(hubQ.replace('export function keys(a) {\n  return [a];\n}\n', ''))), hscope(Q(hubQ.replace('function keys(', 'function keyList(')))], [everyClaimer, everyClaimer]);
t('DS-1002 AC4 a function a script uses through a namespace import runs every suite reaching the module', [hscope(Q(hubQ.replace('return 1;', 'return 2;'))), decide(Q(hubQ.replace('return 1;', 'return 2;')), hmap, { byName: true }).reason.includes('desk/bin/ns.mjs uses wide through the whole of desk/bin/desk-q.mjs')], [everyClaimer, true]);
// `IMP` stands for a dynamic import in ns.mjs, so this suite's own text holds none that loads() reads.
const ns = (src) => hscope(Q(keysEdit), hubWith({ 'desk/bin/ns.mjs': src.replaceAll('IMP', `${'imp'}ort(`) }));
t('DS-1002 AC4 so does any edit while a script passes the whole module on', ns("import * as Q from './desk-q.mjs';\nexport const nsUse = () => use(Q);"), everyClaimer);
t('DS-1002 AC4 a namespace import read only by members the change does not reach does not stop the narrowing', hscope(Q(keysEdit)), 'some: test_lint.sh test_pass.mjs');
t('DS-1002 AC4 an import() bound whole and read by member, or destructured, is followed like an import', [
  ns("const Q = await IMP'./desk-q.mjs');\nexport const nsUse = () => Q.wide();"),
  ns("const { keys } = await IMP'./desk-q.mjs');\nexport const nsUse = () => keys(2);"),
], ['some: test_lint.sh test_pass.mjs', 'some: test_lint.sh test_ns.mjs test_pass.mjs']);
t('DS-1002 AC4 the edited function used through a default import or a member of import(), an import() used any other way, or export * from the module, runs every suite reaching it', [
  ns("import Q from './desk-q.mjs';\nexport const nsUse = () => Q.keys(2);"),
  ns("export const nsUse = async () => (await IMP'./desk-q.mjs')).keys(2);"),
  ns("export const nsUse = () => IMP'./desk-q.mjs').then((m) => m.wide());"),
  ns("export * from './desk-q.mjs';"),
], [everyClaimer, everyClaimer, everyClaimer, everyClaimer]);
const quoted = `${hubQ.replace('export function rows(a) {\n', "export function rows(a) {\n  // unlike keys(), and not 'keys'\n")}const NOTE = ['keys', (n) => \`keys of \${n}\`];\n`;
t('DS-1002 a name only in a comment, a quoted string or a template\'s text reaches nothing', hscope([{ status: 'M', path: 'desk/bin/desk-q.mjs', names: changedNames(quoted, quoted.replace('return [a];', 'return [a, a];')) }], hubWith({ 'desk/bin/desk-q.mjs': quoted })), 'some: test_lint.sh test_pass.mjs');
t('DS-1002 a suite taking the module whole and passing it on runs itself, as nothing loads a suite', hscope(Q(keysEdit), hubWith({ 'tests/test_q.mjs': "// suite: q\nimport * as Q from '../desk/bin/desk-q.mjs';\nscreen(Q);" })), 'some: test_lint.sh test_pass.mjs test_q.mjs');
t('DS-1002 AC5 without byName (CI) the AC1 edit runs every suite reaching the module', [hscope(Q(keysEdit), hmap, { l3Direct: true }), hscope(Q(keysEdit), hmap, {})], [everyClaimer, everyClaimer]);
t('DS-1002 AC6 a shell script under desk/bin/ scopes as before', [hscope(M('desk/bin/with-lock.sh')), hscope(M('desk/bin/with-lock.sh'), hmap, {})], ['some: test_lint.sh test_lock.sh', 'some: test_lint.sh test_lock.sh']);
t('DS-1002 a suite naming the module other than in an import (reading its text) still runs', hscope(Q(keysEdit), hubWith({ 'tests/test_q_text.mjs': "// suite: q text\nconst src = readFileSync(join(R, 'desk/bin/desk-q.mjs'), 'utf8');" })), 'some: test_lint.sh test_pass.mjs test_q_text.mjs');
t('DS-1002 a comment-only change runs nothing but the always set', hscope(Q(hubQ.replace('function fmt', '// formats\nfunction fmt'))), 'some: test_lint.sh');
// The made-up desk-q.mjs with rows() (or the command line) written another way, and an edit to fmt()
// (or draw()) on it.
const rowsAs = (body) => hubQ.replace('export function rows(a) {\n  return fmt(a);\n}', `export function rows(a) {\n  ${body}\n}`);
const onQ = (q, from, to) => hscope([{ status: 'M', path: 'desk/bin/desk-q.mjs', names: changedNames(q, q.replace(from, to)) }], hubWith({ 'desk/bin/desk-q.mjs': q }));
const fmtEdit = (q) => onQ(q, 'return String(a);', 'return `${a}`;');
const drawEdit = (q) => onQ(q, "return 'q';", "return 'r';");
t('DS-1002 a function reaching the edited one through a spread, a nested template or after a regex holding // still reaches it', [
  rowsAs('return [...fmt(a)];'),
  rowsAs('return `${a ? `y` : fmt(a)}`;'),
  rowsAs('return /^https?:\\/\\//.test(a) && fmt(a);'),
  rowsAs('if (a) /\'/.test(a) && fmt(a);\n  return a;'),
  rowsAs('if (a) /"/.test(a) && fmt("y");\n  return a;'),
  // A member call named like a condition's keyword (`.with(`): the `/` after its `)` divides.
  rowsAs("return [a.with(a) / 2 + '/', fmt(a) + ''];"),
  rowsAs("return [new (class { #with(x) { return x; } m(x) { return this.#with(x) / 2 + '/'; } })().m(a), fmt(a) + ''];"),
  // A number's trailing point (`1.`) is no member access: the `if` after it is a condition.
  rowsAs('const n = a + 1.\n  if (a) /"/.test(a) && fmt("y");\n  return n;'),
  // After an exponent or hex literal the point is a member access: `with` there is a property.
  rowsAs("return [1e3.with(a) / 2 + '/', fmt(a) + ''];"),
  rowsAs("return [0x1F.with(a) / 2 + '/', fmt(a) + ''];"),
  rowsAs("return [1e+3.with(a) / 2 + '/', fmt(a) + ''];"),
  rowsAs("return [1.5e-3.with(a) / 2 + '/', fmt(a) + ''];"),
  rowsAs("return [1n.with(a) / 2 + '/', fmt(a) + ''];"),
  rowsAs("return [.5.with(a) / 2 + '/', fmt(a) + ''];"),
  rowsAs("return [a ? .5 : 1, [...a].with(a) / 2 + '/', fmt(a) + ''];"),
].map(fmtEdit), Array(15).fill('some: test_lint.sh test_needs.mjs test_q.mjs'));
const isMainQ = (guard, cond) => hubQ.replace(/const isMain = \(\(\) => \{[\s\S]*?\}\)\(\);\nif \(isMain\)/, `const isMain = ${guard};\nif (${cond})`);
t('DS-1002 a guard function called as `if (isMain())` keeps the command line command-only; one tested uncalled, or a launch test an || or a ternary can turn, does not', [
  drawEdit(isMainQ('() => process.argv[1] === fileURLToPath(import.meta.url)', 'isMain()')),
  drawEdit(isMainQ('() => process.argv[1] === fileURLToPath(import.meta.url)', 'isMain')) === everyClaimer,
  drawEdit(isMainQ('process.argv[1] === fileURLToPath(import.meta.url) || !!process.env.Q', 'isMain')) === everyClaimer,
  drawEdit(isMainQ('() => process.argv[1] === fileURLToPath(import.meta.url) ? false : true', 'isMain()')) === everyClaimer,
  // `?.0` is a ternary before a decimal, not an optional chain; `?.process` is one.
  drawEdit(isMainQ('() => process.argv[1] === fileURLToPath(import.meta.url)?.0:1', 'isMain()')) === everyClaimer,
  drawEdit(isMainQ('() => globalThis?.process.argv[1] === fileURLToPath(import.meta.url)', 'isMain()')),
], ['some: test_cli.sh test_lint.sh', true, true, true, true, 'some: test_cli.sh test_lint.sh']);
// A shell script whose embedded node code imports from desk-q.mjs (loads() reads only its shell lines),
// and which runs pass.mjs, so test_tri.sh claims desk-q.mjs through that.
const triWith = (imp) => hubWith({
  'desk/bin/q-tri.sh': `#!/usr/bin/env bash\nnode "$B/pass.mjs"\nnode --input-type=module - "$B" <<'JS'\nimport { join } from 'node:path';\n${imp}\nJS`,
  'tests/test_tri.sh': '# suite: tri\n"$SRC/desk/bin/q-tri.sh"',
});
const fmtOn = (map, opts) => hscope(Q(hubQ.replace('return String(a);', 'return `${a}`;')), map, opts);
// Every suite claiming desk-q.mjs on this map: the scope without by-name narrowing.
const everyOn = (map) => fmtOn(map, { l3Direct: true });
const triWhole = triWith("const Q = await import(join(process.argv[2], 'desk-q.mjs'));\nconsole.log(Q.rows(1));");
const thenRead = triWith("import(process.argv[2] + '/desk-q.mjs').then((m) => console.log(m.rows(1)));");
const helperWhole = triWith("const load = (f) => import(join(process.argv[2], f));\nconst Q = await load('desk-q.mjs');\nconsole.log(Q.rows(1));");
t('DS-1002 a shell script\'s embedded code importing a reached name runs its suites; one importing another name, beside an unrelated import() helper, does not; one taking the module whole runs every suite claiming it (AC4)', [
  fmtOn(triWith("const { rows } = await import(join(process.argv[2], 'desk-q.mjs'));\nconsole.log(rows(1));")),
  fmtOn(triWith("const load = (f) => import(join(process.argv[2], f));\nconst { keys } = await import(join(process.argv[2], 'desk-q.mjs'));\nconsole.log(keys(1));")),
  fmtOn(triWhole) === everyOn(triWhole), fmtOn(thenRead) === everyOn(thenRead), fmtOn(helperWhole) === everyOn(helperWhole),
  // Through an import helper: the names its result is destructured into count, as an import's do.
  fmtOn(triWith("const load = (f) => import(join(process.argv[2], f));\nconst { rows } = await load('desk-q.mjs');\nconsole.log(rows(1));")),
  fmtOn(triWith("const load = (f) => import(join(process.argv[2], f));\nconst { keys } = await load('desk-q.mjs');\nconsole.log(keys(1));")),
], ['some: test_lint.sh test_needs.mjs test_q.mjs test_tri.sh', 'some: test_lint.sh test_needs.mjs test_q.mjs', true, true, true,
  'some: test_lint.sh test_needs.mjs test_q.mjs test_tri.sh', 'some: test_lint.sh test_needs.mjs test_q.mjs']);
t('DS-1002 a foundational desk/bin/ module (untracked.mjs) is not narrowed by name', decide([{ status: 'M', path: 'desk/bin/untracked.mjs', names: { names: ['deskUntracked'] } }], real, { byName: true }).scope, 'full');
// On this repo: an edit to desk-q.mjs's checkFlags, which its command line and the screen run. Its
// command line reaches most of the module, and bin/desk-q, which launches it, is claimed through
// install.sh by most suites, so this narrows to few fewer suites than CI's.
const deskQ = readFileSync(join(R, 'desk/bin/desk-q.mjs'), 'utf8');
const flagsEdit = deskQ.replace("const unknown = argv.filter((a) => a.startsWith('--') && ", "const unknown = argv.filter((a) => a.slice(0, 2) === '--' && ");
const realQ = (opts) => decide([{ status: 'M', path: 'desk/bin/desk-q.mjs', names: changedNames(deskQ, flagsEdit) }], real, opts);
const [qCi, qLocal] = [realQ({}), realQ({ byName: true })];
t('DS-1002 AC1 on the real desk-q.mjs: an edit to checkFlags narrows on it, runs the suite driving desk-q\'s command line, and no suite CI would not',
  [flagsEdit !== deskQ, qLocal.narrowed, qLocal.suites.includes('test_desk_q.mjs'), qLocal.suites.filter((s) => !qCi.suites.includes(s))], [true, ['desk/bin/desk-q.mjs: checkFlags'], true, []]);
// On this repo: triage.sh's embedded node code imports usageLimit from usage-limit.mjs, which loads()
// does not read (a script's shell lines only), so the suite running triage.sh still runs on an edit to it.
const limitSrc = readFileSync(join(R, 'desk/bin/usage-limit.mjs'), 'utf8');
const limitEdit = limitSrc.replace('export function usageLimit(text) {\n  const limits = [];', 'export function usageLimit(text) {\n  const limits = [].slice();');
const limitScope = (opts) => decide([{ status: 'M', path: 'desk/bin/usage-limit.mjs', names: changedNames(limitSrc, limitEdit) }], real, opts);
t('DS-1002 on the real usage-limit.mjs: an edit to usageLimit, which triage.sh imports in embedded code, runs test_triage.sh',
  [limitEdit !== limitSrc, limitScope({}).suites.includes('test_triage.sh'), limitScope({ byName: true }).suites.includes('test_triage.sh'), limitScope({ byName: true }).narrowed], [true, true, true, ['desk/bin/usage-limit.mjs: usageLimit']]);
// And decisions.mjs's ticketCalls, which triage.sh takes through its `load('decisions.mjs')` helper.
const callsSrc = readFileSync(join(R, 'desk/bin/decisions.mjs'), 'utf8');
const callsEdit = callsSrc.replace('const over = new Map(overrides.filter(', 'const over = new Map([].concat(overrides).filter(');
const callsScope = decide([{ status: 'M', path: 'desk/bin/decisions.mjs', names: changedNames(callsSrc, callsEdit) }], real, { byName: true });
t('DS-1002 on the real decisions.mjs: an edit to ticketCalls, which triage.sh takes through an import helper, runs test_triage.sh',
  [callsEdit !== callsSrc, callsScope.suites.includes('test_triage.sh'), callsScope.narrowed], [true, true, ['desk/bin/decisions.mjs: ticketCalls']]);
// DS-1003 AC1: a frozen literal constant no load-time code reaches narrows to the suites naming it.
const frozenEnv = cliEnv.replace('export function alone() {', "export const KINDS = Object.freeze(['a', 'b']);\nexport function alone() {");
const frozenNamed = { ...named, 'desk/bin/desk-env.mjs': frozenEnv, 'tests/test_kinds.mjs': "// suite: kinds\nimport { KINDS } from '../desk/bin/desk-env.mjs';" };
const frozen = decide(N('desk/bin/desk-env.mjs', frozenEnv, frozenEnv.replace("['a', 'b']", "['a', 'b', 'c']")), buildMap(Object.keys(frozenNamed), (p) => frozenNamed[p]), { byName: true });
t('DS-1003 AC1 a frozen list no load-time code reaches narrows to the suites naming it', [frozen.scope, frozen.suites, frozen.reason.endsWith(', narrowed on the changed names in desk/bin/desk-env.mjs: KINDS')], ['some', ['test_kinds.mjs', 'test_lint.sh'], true]);
const T = scratch('desk-scope-');
try {
  const out = join(T, 'out');
  writeFileSync(out, '');
  const gh = spawnSync(process.execPath, [join(R, 'tests/scope_sections.mjs'), '--files', '.github/workflows/tests.yml', '--github-output'], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
  const lines = execFileSync('cat', [out], { encoding: 'utf8' }).split('\n');
  t('cli --github-output writes scope, reason, suites, shells', [gh.status, lines[0], lines[2] === `suites=${listed.join(' ')}`, lines[3].startsWith('shells=')], [0, 'scope=full', true, true]);

  // ---- a worktree's untracked files ---------------------------------------------------------------
  // A desk resume file or a desk-review run's scratch files, left untracked, are not the change.
  const W = join(T, 'wt');
  const g = (...a) => execFileSync('git', ['-C', W, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  mkdirSync(join(W, 'desk/bin'), { recursive: true });
  mkdirSync(join(W, 'tests'));
  writeFileSync(join(W, '.gitignore'), 'node_modules\n');
  writeFileSync(join(W, 'desk/bin/tool.mjs'), 'export const a = 1;\n');
  writeFileSync(join(W, 'desk/bin/other.mjs'), 'export const b = 1;\n');
  writeFileSync(join(W, 'tests/test_tool.mjs'), "// suite: tool\n// layer: L1\nimport { a } from '../desk/bin/tool.mjs';\n");
  writeFileSync(join(W, 'tests/test_other.mjs'), "// suite: other\n// layer: L1\nimport { b } from '../desk/bin/other.mjs';\n");
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-qm', 'base');
  g('checkout', '-qb', 'work');
  writeFileSync(join(W, 'desk/bin/tool.mjs'), 'export const a = 2;\n');
  const wmap = repoMap(W);
  const wch = changesAgainst(W, 'main');
  t('DS-1002 the worktree\'s change to a desk/bin/ module carries its changed names, and narrows on them', [wch.find((c) => c.path === 'desk/bin/tool.mjs')?.names, decide(wch, wmap, { byName: true }).narrowed], [{ names: ['a'] }, ['desk/bin/tool.mjs: a']]);
  const scopeWith = (...files) => {
    for (const f of files) { mkdirSync(dirname(join(W, f)), { recursive: true }); writeFileSync(join(W, f), '{}'); }
    const d = decide(changesAgainst(W, 'main'), wmap);
    g('clean', '-qfdx');
    return [d.scope, d.suites];
  };
  const toolOnly = ['some', ['test_tool.mjs']];
  t('DS-997 AC1 an untracked desk-review codex brief at the root leaves the edited script\'s suites', scopeWith('desk-review-codex-brief-r1.txt'), toolOnly);
  t('DS-997 AC2 an untracked desk-review results file or seat brief at the root does not make it full',
    [scopeWith('desk-review-results-r1.json'), scopeWith('desk-review-finder-brief-r1.txt')], [toolOnly, toolOnly]);
  t('DS-997 AC3 an untracked desk-ticket resume file does not change the scope', scopeWith('.claude/desk-ticket-DS-1.json'), toolOnly);
  t('DS-997 AC4 any other untracked root file is still full', scopeWith('.npmrc')[0], 'full');
  writeFileSync(join(W, '.gitignore'), 'node_modules\ndist\n');
  g('commit', '-qam', 'ignore dist');
  t('DS-997 AC5 a committed root config change is still full with --base and --head', decide(changesAgainst(W, 'main', 'HEAD'), wmap).scope, 'full');

  // ---- tests/run.sh's suite filter --------------------------------------------------------------
  const run = (...a) => spawnSync('bash', [join(R, 'tests/run.sh'), ...a], { encoding: 'utf8' });
  const one = run('test_review_verdict.mjs');
  t('run.sh <suite> runs that suite and the hook self-test only', [one.status, (one.stdout.match(/^== /gm) ?? []).length, /== desk-review verdict/.test(one.stdout)], [0, 2, true]);
  t('run.sh takes a tests/ path too', run('tests/test_review_verdict.mjs').status, 0);
  const bad = run('test_nope.mjs');
  t('run.sh with an unknown suite fails and runs nothing', [bad.status, /no such suite/.test(bad.stdout), /^== /m.test(bad.stdout)], [2, true, false]);
  t('run.sh with something not a suite fails', run('stub_jira.py').status, 2);
} finally { rmSync(T, { recursive: true, force: true }); }

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
