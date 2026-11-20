// suite: CI scope (the suites a pull request's change reaches; anything unplaced runs every suite)
// claims: imports (repo file names below are test data, not what this suite runs)
// tests/scope_sections.mjs on a made-up tree, then on this repo, then tests/run.sh's suite filter.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMap, decide, mentions, globRe, loads, parseNameStatus, repoMap, addedExports, ALWAYS } from './scope_sections.mjs';
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
], [null, null, null, null, null, null, null, null, null]);
t('DS-818 addedExports: a new name that shadows a global or a name the module already uses is not export-only', [
  addedExports(env, `${env}export function fetch() {}\n`),
  addedExports(env, `${env}export const URL = 'x';\n`),
  addedExports(`${env}export function usesY() {\n  return y;\n}\n`, `${env}export function usesY() {\n  return y;\n}\nexport const y = 2;\n`),
], [null, null, null]);
t('DS-818 addedExports: literal values, multi-line function bodies and arrows still count', addedExports(env, `${env}export const LIMITS = { max: 3, names: ['a', "b"], on: true, off: null, n: -1.5 };\nexport function g(a = 1) {\n  if (a) { return [a]; }\n  return null;\n}\nexport const h = async (x) => {\n  return x;\n};\n`), ['LIMITS', 'g', 'h']);

// ---- this repo -----------------------------------------------------------------------------------
const real = repoMap(R);
const listed = execFileSync('git', ['-C', R, 'ls-files', 'tests/test_*.sh', 'tests/test_*.mjs'], { encoding: 'utf8' }).trim().split('\n').map((f) => f.slice(6)).sort();
t('every suite in the repo is in the map', real.suites.map((s) => s.file).sort(), listed);
t('this suite and its script are foundational', [decide(M('tests/scope_sections.mjs'), real).scope, decide(M('tests/bash32_check.sh'), real).scope], ['full', 'full']);
// Regressions from review: a script pass.mjs launches reaches the end-to-end batch suite, or runs all.
for (const f of ['desk/bin/base-gate.mjs', 'desk/bin/with-lock.sh']) {
  const d = decide(M(f), real);
  t(`${f} selects test_batch_e2e.sh or runs everything`, d.scope === 'full' || d.suites.includes('test_batch_e2e.sh'), true);
}
t('a suite with claims: imports claims nothing it only names, only what it imports', [...real.claims].filter(([, s]) => s.has('test_scope_sections.mjs')).map(([p]) => p), ['tests/scope_sections.mjs']);
// A suite that walks the repo tree must say what it reads with a covers: line, or what it reads is unclaimed.
const walks = /\b(readdirSync|readdir|walk|markdownFiles)\s*\(\s*(\[?\s*join\(\s*(root|R|ROOT|SRC)\b|refs\b|skill\b)|git ls-files/;
const uncovered = real.suites.filter((s) => !ALWAYS.includes(s.file) && !s.importsOnly && !s.covers.length && walks.test(readFileSync(join(R, 'tests', s.file), 'utf8'))).map((s) => s.file);
t('every suite that walks the repo tree has a covers: line', uncovered, []);
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
// DS-818 AC4 to AC6 on this repo: each runs the suites that claim it, not every suite.
for (const f of ['desk-config.md', 'install.sh', 'tests/compare_pass.sh', 'tests/compare_pass.mjs', 'tests/pass_setup.sh']) {
  const d = decide(M(f), real);
  t(`DS-818 ${f} runs the suites that claim it`, [d.scope, d.suites], ['some', real.suites.map((s) => s.file).filter((s) => ALWAYS.includes(s) || real.claims.get(f)?.has(s))]);
}
t('a desk-pr reference reaches the desk-pr split suite', decide(M('skills/desk-pr/references/opening.md'), real).suites.includes('test_desk_pr_split.mjs'), true);
const cli = spawnSync(process.execPath, [join(R, 'tests/scope_sections.mjs'), '--files', 'desk/bin/merge-driver.sh', '--json'], { encoding: 'utf8' });
const j = JSON.parse(cli.stdout || '{}');
t('cli --files --json', [cli.status, j.scope, j.suites?.includes('test_merge_driver_loop.sh'), j.shells?.includes('desk/bin/merge-driver.sh')], [0, 'some', true, true]);
const T = mkdtempSync(join(tmpdir(), 'desk-scope-'));
try {
  const out = join(T, 'out');
  writeFileSync(out, '');
  const gh = spawnSync(process.execPath, [join(R, 'tests/scope_sections.mjs'), '--files', '.github/workflows/tests.yml', '--github-output'], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
  const lines = execFileSync('cat', [out], { encoding: 'utf8' }).split('\n');
  t('cli --github-output writes scope, reason, suites, shells', [gh.status, lines[0], lines[2] === `suites=${listed.join(' ')}`, lines[3].startsWith('shells=')], [0, 'scope=full', true, true]);

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
