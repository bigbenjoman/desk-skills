// suite: worker test scope and the memory status line
// claims: imports (repo file names below are test data, not what this suite runs)
// What a worker tests before pushing (related tests, or the full suites when a change reaches past the
// import graph), and the `desk-env mem status` line. Scratch repos only.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, runs, parseNameStatus, workspacePackages, sharedPackages, takesFiles, isConfig, uncoveredWorkspaces, packageManager, workspaceTestCmd } from '../desk/bin/test-scope.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const T = mkdtempSync(join(tmpdir(), 'desk-test-scope-'));

// ---- the decision, on fixture diffs ---------------------------------------------------------
const ws = join(T, 'ws');
const pkg = (dir, body) => { mkdirSync(join(ws, dir), { recursive: true }); writeFileSync(join(ws, dir, 'package.json'), JSON.stringify(body)); };
mkdirSync(ws, { recursive: true });
writeFileSync(join(ws, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - \"packages/*\"\n  # a comment\n  - '!packages/scratch'\n");
pkg('.', { name: 'root', private: true });
pkg('apps/web', { name: 'web', dependencies: { '@acme/ui': 'workspace:*' } });
pkg('apps/admin', { name: 'admin', devDependencies: { '@acme/ui': 'workspace:*' }, scripts: { test: 'vitest run' } });
pkg('packages/ui', { name: '@acme/ui' });
pkg('packages/leaf', { name: '@acme/leaf' });
pkg('packages/scratch', { name: '@acme/scratch' });
const pkgs = workspacePackages(ws);
t('pnpm workspace globs expand to package dirs, less a negation', pkgs.map((p) => p.dir).join(' '), 'apps/admin apps/web packages/leaf packages/ui');
const shared = sharedPackages(pkgs);
t('a package another package depends on is shared', shared.map((s) => `${s.dir}<-${s.by.join('+')}`).join(' '), 'packages/ui<-apps/admin+apps/web');

const ch = (...paths) => paths.map((p) => ({ status: 'M', path: p }));
const scope = (changes, opts = { shared }) => { const d = decide(changes, opts); return `${d.scope}: ${d.reason}`; };
t('a leaf file runs related tests', scope(ch('apps/web/src/button.tsx', 'apps/web/src/button.test.tsx')).startsWith('related: 2 changed file(s)'), true);
t('an unshared workspace package is a leaf', scope(ch('packages/leaf/src/x.ts')).startsWith('related:'), true);
t('a shared package runs the full suites', scope(ch('apps/web/src/a.ts', 'packages/ui/src/button.tsx')),
  'full: packages/ui/src/button.tsx is in packages/ui (@acme/ui), a shared package apps/admin, apps/web depend on');
t('a lockfile runs the full suites', scope(ch('apps/web/src/a.ts', 'pnpm-lock.yaml')), 'full: pnpm-lock.yaml is a lockfile');
t('a nested lockfile counts', scope(ch('apps/api/uv.lock')), 'full: apps/api/uv.lock is a lockfile');
t('root config runs the full suites', scope(ch('vitest.config.ts')), 'full: vitest.config.ts is root config');
t('any root file other than docs is root config', scope(ch('.npmrc')), 'full: .npmrc is root config');
t('a project\'s test config runs the full suites', scope(ch('apps/web/tsconfig.json')), 'full: apps/web/tsconfig.json is test or build config');
t('conftest.py anywhere', scope(ch('apps/api/tests/conftest.py')), 'full: apps/api/tests/conftest.py is test or build config');
t('a root README is not config', scope(ch('README.md')).startsWith('related:'), true);
t('a deletion runs the full suites', scope([{ status: 'D', path: 'apps/web/src/old.ts' }]), 'full: apps/web/src/old.ts was deleted');
t('a rename runs the full suites', scope([{ status: 'R', path: 'apps/web/src/b.ts', from: 'apps/web/src/a.ts' }]), 'full: apps/web/src/a.ts was renamed to apps/web/src/b.ts');
t('no related-tests row runs the full suites', scope(ch('apps/web/src/a.ts'), { shared, related: false }), 'full: §4 Related tests is none or unset');
t('nothing changed runs nothing', decide([], { shared }).scope, 'none');
t('isConfig: a source file is not config', isConfig('apps/web/src/config.ts'), false);
t('isConfig: next.config.mjs is', isConfig('apps/web/next.config.mjs'), true);

// ---- what runs --------------------------------------------------------------------------------
const related = [{ dir: 'apps/web', cmd: 'pnpm vitest related --run' }, { dir: 'apps/api', cmd: 'uv run pytest --testmon' }, { dir: '.', cmd: 'pnpm jest --findRelatedTests' }];
const full = [{ dir: '.', cmd: 'pnpm turbo run test' }, { dir: 'apps/api', cmd: 'uv run pytest' }];
const show = (rs) => rs.map((r) => `${r.dir}|${r.cmd}|${r.files.join(',')}`).join(' ; ');
t('related: each file to its closest suite, relative to its dir; pytest picks its own set', show(runs(decide(ch('apps/web/src/a.ts', 'apps/api/app/m.py', 'lib/x.ts'), { shared }), { relatedItems: related, fullItems: full })),
  'apps/web|pnpm vitest related --run|src/a.ts ; apps/api|uv run pytest --testmon| ; .|pnpm jest --findRelatedTests|lib/x.ts');
t('related: a suite with no changed file under it is skipped', show(runs(decide(ch('apps/web/src/a.ts'), { shared }), { relatedItems: related.slice(0, 2), fullItems: full })),
  'apps/web|pnpm vitest related --run|src/a.ts');
t('related: a file whose suite has no related item runs that suite in full', show(runs(decide(ch('apps/web/src/a.ts', 'apps/api/app/m.py'), { shared }), { relatedItems: related.slice(0, 1), fullItems: full })),
  'apps/web|pnpm vitest related --run|src/a.ts ; apps/api|uv run pytest|');
t('related: a root related item does not swallow a deeper suite', show(runs(decide(ch('src/a.ts', 'apps/api/app/m.py'), { shared }), { relatedItems: [{ dir: '.', cmd: 'pnpm vitest related --run' }], fullItems: [{ dir: '.', cmd: 'pnpm vitest run' }, { dir: 'apps/api', cmd: 'uv run pytest' }] })),
  '.|pnpm vitest related --run|src/a.ts ; apps/api|uv run pytest|');
t('related: two suites in one directory with no related item both run in full', show(runs(decide(ch('apps/api/app/s.py'), { shared }), { relatedItems: related.slice(0, 1), fullItems: [{ dir: 'apps/api', cmd: 'uv run pytest' }, { dir: 'apps/api', cmd: 'uv run pytest tests/contract' }] })),
  'apps/api|uv run pytest| ; apps/api|uv run pytest tests/contract|');
t('related: fewer related items than suites in a directory runs its suites in full too', show(runs(decide(ch('lib/m.py'), { shared }), { relatedItems: [{ dir: '.', cmd: 'pnpm vitest related --run' }], fullItems: [{ dir: '.', cmd: 'pnpm vitest run' }, { dir: '.', cmd: 'uv run pytest' }] })),
  '.|pnpm vitest related --run|lib/m.py ; .|pnpm vitest run| ; .|uv run pytest|');
t('related: every related item in the directory gets the file', show(runs(decide(ch('src/a.ts'), { shared }), { relatedItems: [{ dir: '.', cmd: 'pnpm vitest related --run' }, { dir: '.', cmd: 'pnpm jest --findRelatedTests' }], fullItems: [{ dir: '.', cmd: 'pnpm vitest run' }, { dir: '.', cmd: 'pnpm jest' }] })),
  '.|pnpm vitest related --run|src/a.ts ; .|pnpm jest --findRelatedTests|src/a.ts');
t('related: a file under no suite runs nothing', show(runs(decide(ch('docs/x.txt'), { shared }), { relatedItems: related.slice(0, 1), fullItems: full.slice(1) })), '');
t('full: every Unit tests item, no files', show(runs(decide(ch('pnpm-lock.yaml'), { shared }), { relatedItems: related, fullItems: full })),
  '.|pnpm turbo run test| ; apps/api|uv run pytest|');

// ---- touched workspaces no suite covers -------------------------------------------------------
const loose = (paths, opts) => uncoveredWorkspaces(decide(ch(...paths), { shared }), pkgs, opts).map((w) => `${w.dir}:${w.test ?? '-'}`).join(' ');
const webOnly = { relatedItems: [{ dir: 'apps/web', cmd: 'pnpm vitest related --run' }], fullItems: [{ dir: 'apps/web', cmd: 'pnpm test' }] };
t('DS-495 AC1 two touched workspaces: the one no item covers is named, with its test script', loose(['apps/web/src/a.ts', 'apps/admin/src/b.ts'], webOnly), 'apps/admin:vitest run');
t('DS-495 a workspace with no test script is named without one', loose(['packages/leaf/src/x.ts'], webOnly), 'packages/leaf:-');
t('DS-495 a root item covers every workspace', loose(['apps/admin/src/b.ts'], { relatedItems: [], fullItems: [{ dir: '.', cmd: 'pnpm turbo run test' }] }), '');
t('DS-495 a file outside every workspace is not a workspace', loose(['scripts/x.ts'], webOnly), '');
t('DS-495 scope full: only Unit tests items cover', uncoveredWorkspaces(decide(ch('apps/admin/src/b.ts', 'pnpm-lock.yaml'), { shared }), pkgs, { relatedItems: [{ dir: 'apps/admin', cmd: 'pnpm vitest related --run' }], fullItems: webOnly.fullItems }).map((w) => w.dir).join(' '), 'apps/admin');
t('DS-495 nothing changed names nothing', uncoveredWorkspaces(decide([], { shared }), pkgs, webOnly).length, 0);
t('packageManager: the configured row wins', packageManager(ws, 'pnpm (npm, npx forbidden)'), 'pnpm');
t('packageManager: none falls back to npm with no lockfile', packageManager(ws, 'none'), 'npm');
writeFileSync(join(ws, 'yarn.lock'), '');
t('packageManager: a root lockfile names it', packageManager(ws, null), 'yarn');
t('workspaceTestCmd: no cap with no runner shown', workspaceTestCmd('pnpm', 'node --test', '4'), 'pnpm run test');
t('workspaceTestCmd: a Vitest script takes the cap', workspaceTestCmd('pnpm', 'vitest run', '4, 2 while the spawn gate says hold'), 'pnpm run test --maxWorkers=4');
t('workspaceTestCmd: npm passes it after --', workspaceTestCmd('npm', 'jest', '2'), 'npm run test -- --maxWorkers=2');
t('workspaceTestCmd: no cap set', workspaceTestCmd('pnpm', 'jest', null), 'pnpm run test');

t('takesFiles: vitest', takesFiles('pnpm vitest related --run'), true);
t('takesFiles: a path to jest', takesFiles('node node_modules/.bin/jest --findRelatedTests'), true);
t('takesFiles: a word containing jest is not jest', takesFiles('pnpm run jester'), false);
t('takesFiles: pytest', takesFiles('uv run pytest --testmon'), false);
t('parseNameStatus: rename, untracked', JSON.stringify(parseNameStatus('M\ta.ts\nR087\told.ts\tnew.ts\n?? fresh.ts\n')),
  JSON.stringify([{ status: 'M', path: 'a.ts' }, { status: 'R', path: 'new.ts', from: 'old.ts' }, { status: 'A', path: 'fresh.ts' }]));

// ---- end to end: `desk-env test-scope` in a scratch repo ---------------------------------------
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-env.mjs');
const repo = join(T, 'repo');
const bare = join(T, 'origin.git');
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'T');
mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
writeFileSync(join(repo, 'package.json'), '{"name":"r"}\n');
g('add', '.'); g('commit', '-qm', 'base'); g('remote', 'add', 'origin', bare); g('push', '-q', 'origin', 'main');
g('switch', '-qc', 'feat/x');
let cfgs = 0;
const cfg = (rows) => { const f = join(T, `cfg-${++cfgs}.md`); writeFileSync(f, `## 0. Repo\n\n| Field | Value |\n|---|---|\n| Default branch | \`main\` |\n\n## 4. Toolchain\n\n| Field | Value |\n|---|---|\n${rows}`); return f; };
const withRelated = cfg('| Unit tests | `pnpm test` |\n| Related tests | `pnpm vitest related --run` |\n');
const noRelated = cfg('| Unit tests | `pnpm test` |\n| Related tests | `none` |\n');
const scopeCli = (config) => spawnSync('node', [BIN, 'test-scope'], { cwd: repo, encoding: 'utf8',
  env: { ...process.env, DESK_CONFIG: config, DESK_MACHINE: join(T, 'none.md'), HOME: T, DESK_DEFAULT_BRANCH: '' } }).stdout.replace(/\n+$/, '').split('\n').join(' | ');
writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
g('commit', '-qam', 'change a');
writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 1;\n'); // untracked, still counted
t('cli: committed and untracked leaf files run related', scopeCli(withRelated),
  'scope=related | reason=2 changed file(s): no lockfile, config, shared package, deletion or rename | changed=2 | .\tpnpm vitest related --run\tsrc/a.ts src/b.ts');
t('cli: Related tests none runs Unit tests', scopeCli(noRelated), 'scope=full | reason=§4 Related tests is none or unset | changed=2 | .\tpnpm test\t');
writeFileSync(join(repo, 'package.json'), '{"name":"r","type":"module"}\n');
t('cli: an uncommitted root config change runs the full suites', scopeCli(withRelated), 'scope=full | reason=package.json is root config | changed=3 | .\tpnpm test\t');

// A monorepo whose suites cover apps/web only; apps/portal has a test script and no suite of its own.
const mono = join(T, 'mono');
const m = (...a) => execFileSync('git', ['-C', mono, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (p, body) => { mkdirSync(dirname(join(mono, p)), { recursive: true }); writeFileSync(join(mono, p), body); };
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(T, 'mono.git')]);
execFileSync('git', ['init', '-q', '-b', 'main', mono]);
m('config', 'user.email', 't@example.com'); m('config', 'user.name', 'T');
put('pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
put('pnpm-lock.yaml', 'lockfileVersion: 9\n');
put('apps/web/package.json', '{"name":"web","scripts":{"test":"vitest run"}}\n');
put('apps/web/src/a.ts', 'export const a = 1;\n');
put('apps/portal/package.json', '{"name":"portal","scripts":{"test":"vitest run"}}\n');
put('apps/portal/src/main.tsx', 'export const App = () => null;\n');
m('add', '.'); m('commit', '-qm', 'base'); m('remote', 'add', 'origin', join(T, 'mono.git')); m('push', '-q', 'origin', 'main');
m('switch', '-qc', 'feat/portal');
const monoCfg = join(T, 'cfg-mono.md');
writeFileSync(monoCfg, readFileSync(cfg('| Package manager | `pnpm` |\n| Unit tests | `apps/web: pnpm test` |\n| Related tests | `apps/web: pnpm vitest related --run` |\n'), 'utf8')
  + '\n## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Test worker cap under the test lock | `4` | `3` |\n');
const monoCli = () => spawnSync('node', [BIN, 'test-scope'], { cwd: mono, encoding: 'utf8',
  env: { ...process.env, DESK_CONFIG: monoCfg, DESK_MACHINE: join(T, 'none.md'), HOME: T, DESK_DEFAULT_BRANCH: '' } }).stdout.replace(/\n+$/, '').split('\n');
put('apps/web/src/a.ts', 'export const a = 2;\n');
put('apps/portal/src/main.tsx', 'export const App = () => 1;\n');
m('commit', '-qam', 'touch two workspaces');
t('DS-495 AC1 cli: a second touched workspace no item covers runs its test script too', monoCli().join(' | '),
  'scope=related | reason=2 changed file(s): no lockfile, config, shared package, deletion or rename | changed=2 | workspace=apps/portal (portal) has a changed file no §4 Related or Unit tests item covers, so its suite line runs its package.json test script (vitest run) there; workspace-test caps it, so add no --maxWorkers | apps/web\tpnpm vitest related --run\tsrc/a.ts | .\tdesk-env workspace-test apps/portal\t');
put('pnpm-lock.yaml', 'lockfileVersion: 9\n# admin\n');
put('apps/admin/package.json', '{"name":"admin","scripts":{"test":"jest"}}\n');
put('apps/admin/src/x.ts', 'export const x = 1;\n');
put('apps/docs/package.json', '{"name":"docs"}\n');
t('DS-495 AC2+AC3 cli: a new workspace runs its test script; one with none is named UNCOVERED', monoCli().join(' | '),
  'scope=full | reason=pnpm-lock.yaml is a lockfile | changed=6 | workspace=apps/admin (admin) has a changed file no §4 Related or Unit tests item covers, so its suite line runs its package.json test script (jest) there; workspace-test caps it, so add no --maxWorkers'
  + ' | workspace=apps/portal (portal) has a changed file no §4 Related or Unit tests item covers, so its suite line runs its package.json test script (vitest run) there; workspace-test caps it, so add no --maxWorkers'
  + ' | apps/web\tpnpm test\t | .\tdesk-env workspace-test apps/admin\t | .\tdesk-env workspace-test apps/portal\t'
  + ' | UNCOVERED\tapps/docs (docs)\thas a changed file no §4 Related or Unit tests item covers and no package.json test script: nothing ran for it, so the PR\'s Testing names it untested and never says its tests passed');

// `desk-env workspace-test`, against a stub pnpm: the uncommitted apps/admin (a workspace the branch adds,
// after any worker spawned) runs in its directory, capped; a failing script fails the command; a directory
// that is no workspace package, or one with no test script, runs nothing.
const stubBin = join(T, 'stub-path');
mkdirSync(stubBin, { recursive: true });
writeFileSync(join(stubBin, 'pnpm'), '#!/bin/sh\necho "pnpm $* in ${PWD##*/}"\ngrep -q failing package.json && exit 1\nexit 0\n', { mode: 0o755 });
const wsTest = (dir) => { const r = spawnSync('node', [BIN, 'workspace-test', dir], { cwd: mono, encoding: 'utf8',
  env: { ...process.env, DESK_CONFIG: monoCfg, DESK_MACHINE: join(T, 'none.md'), HOME: T, PATH: `${stubBin}:${process.env.PATH}` } });
  return `${r.status}: ${`${r.stdout}${r.stderr}`.trim().split('\n').join(' | ')}`; };
t('DS-495 AC2 workspace-test: a workspace added on the branch runs in its directory, capped', wsTest('apps/admin'),
  '0: pnpm run test --maxWorkers=3 in admin | PASS apps/admin: pnpm run test --maxWorkers=3 (exit 0)');
put('apps/admin/package.json', '{"name":"admin","scripts":{"test":"jest --failing"}}\n');
// Compared as a boolean: the suite runner reads the word for a failed check anywhere in this output.
t('DS-495 AC3 workspace-test: a failing test script exits 1 with its failed line, never PASS', wsTest('./apps/admin/')
  === '1: pnpm run test --maxWorkers=3 in admin | FAIL apps/admin: pnpm run test --maxWorkers=3 (exit 1)', true);
t('DS-495 workspace-test: no test script runs nothing', wsTest('apps/docs'), '2: desk-env workspace-test: apps/docs has no package.json test script');
t('DS-495 workspace-test: a directory that is no workspace package runs nothing', wsTest('../mono.git').startsWith('2: desk-env workspace-test: ../mono.git is not a workspace package'), true);

// ---- `desk-env mem status` ----------------------------------------------------------------------
// A profile written while desk had a CI runner still holds its reservation row, which nothing reads.
const profile = join(T, 'machine.md');
writeFileSync(profile, '# Machine profile\n\n## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `runner-memory-reserved-gb` | `24` | the runner VM memory |\n');
const mem = (machine) => spawnSync('node', [BIN, 'mem', 'status'], { encoding: 'utf8',
  env: { ...process.env, DESK_CONFIG: noRelated, DESK_MACHINE: machine, HOME: T } }).stdout.trim();
t('mem status: an old profile\'s runner reservation holds nothing back', /^vmmem=\S+ avail=\S+ rss=\S+$/.test(mem(profile)), true);
t('mem status: no profile', /^vmmem=\S+ avail=\S+ rss=\S+$/.test(mem(join(T, 'none.md'))), true);

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all test-scope checks passed');
process.exit(fails ? 1 : 0);
