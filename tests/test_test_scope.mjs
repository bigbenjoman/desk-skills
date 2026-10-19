// suite: worker test scope and the runner's ladder reservation
// What a worker tests before pushing (related tests, or the full suites when a change reaches past the
// import graph), and the runner VM's memory held back from the autopilot ladder. Scratch repos and
// fake tart/lsof/ps only; nothing reads this computer's VM.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, runs, parseNameStatus, workspacePackages, sharedPackages, takesFiles, isConfig } from '../desk/bin/test-scope.mjs';
import { runnerReservation, ladderMemory, runnerSegment } from '../desk/bin/desk-env.mjs';
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
pkg('apps/admin', { name: 'admin', devDependencies: { '@acme/ui': 'workspace:*' } });
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

// ---- the runner VM's reservation ----------------------------------------------------------------
t('no runner, nothing reserved', runnerReservation({ running: false, reservedGiB: 24, residentGiB: 0 }), null);
t('no reservation in the profile, nothing reserved', runnerReservation({ running: true, reservedGiB: 0, residentGiB: 3 }), null);
t('a running VM holds back its reservation less what it has touched', runnerReservation({ running: true, reservedGiB: 24, residentGiB: 6 }).heldGiB, 18);
t('a fully resident VM holds back nothing more', runnerReservation({ running: true, reservedGiB: 24, residentGiB: 25 }).heldGiB, 0);
t('an unread resident size holds back all of it', runnerReservation({ running: true, reservedGiB: 24, residentGiB: NaN }).heldGiB, 24);
t('the ladder gates on avail less what is held back', ladderMemory(30, { running: true, reservedGiB: 24, residentGiB: 6 }).gate, 12);
t('the ladder never goes below zero', ladderMemory(5, { running: true, reservedGiB: 24, residentGiB: 0 }).gate, 0);
t('without a runner the ladder is avail', ladderMemory(30, { running: false, reservedGiB: 24, residentGiB: 0 }).gate, 30);
t('status segment', runnerSegment(ladderMemory(30, { running: true, reservedGiB: 24, residentGiB: 6 })), ' runner=24.0G reserved (6.0G resident, 18.0G held back) ladder=12.0G');
t('no status segment without a runner', runnerSegment(ladderMemory(30, { running: false, reservedGiB: 24, residentGiB: 0 })), '');

// `desk-env mem status` with fake tart, lsof and ps on PATH, and a profile reserving 24 GB.
const fake = join(T, 'bin');
mkdirSync(fake);
const script = (name, body) => { writeFileSync(join(fake, name), `#!/bin/sh\n${body}\n`); chmodSync(join(fake, name), 0o755); };
script('tart', '[ "$1" = get ] && [ "$2" = desk-runner ] && { [ -f "$RUNNING" ] && echo \'{"Running":true}\' || echo \'{"Running":false}\'; exit 0; }; exit 1');
script('lsof', 'case "$2" in */vms/desk-runner/disk.img) echo 4242 ;; esac');
script('ps', 'case "$*" in "-o rss= -p 4242") echo 6291456 ;; *) exec /bin/ps "$@" ;; esac'); // 6 GiB in KiB
const profile = join(T, 'machine.md');
writeFileSync(profile, '# Machine profile\n\n## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `runner-memory-reserved-gb` | `24` | the runner VM memory |\n');
const running = join(T, 'running');
const mem = (machine) => spawnSync('node', [BIN, 'mem', 'status'], { encoding: 'utf8',
  env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, DESK_CONFIG: noRelated, DESK_MACHINE: machine, HOME: T, RUNNING: running } }).stdout.trim();
t('mem status: a stopped VM reserves nothing', /^vmmem=\S+ avail=\S+ rss=\S+$/.test(mem(profile)), true);
writeFileSync(running, '');
const line = mem(profile);
t('mem status: a running VM shows its reservation and the ladder figure', /^vmmem=\S+ avail=\S+ rss=\S+ runner=24\.0G reserved \(6\.0G resident, 18\.0G held back\) ladder=\S+G$/.test(line), true);
t('mem status: no profile reserves nothing', /^vmmem=\S+ avail=\S+ rss=\S+$/.test(mem(join(T, 'none.md'))), true);

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all test-scope checks passed');
process.exit(fails ? 1 : 0);
