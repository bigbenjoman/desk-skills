// suite: spine check (a feature child's owned specs, and the specs it must leave alone)
// layer: L2
import { mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { declarations, scanChild, specsCommand, runSpecs, checkChild, batchSpecPaths } from '../desk/bin/spine-check.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const S = (xs) => JSON.stringify(xs);
const owners = { AC1: 'K-1', AC2: 'K-2' };
// One child's check on one spec file it changed from `before` to `after`.
const child = (key, path, before, after) => scanChild({ head: [{ path, text: after }], changed: [{ path, before, after }], owners, key }).problems;

// A spec body never runs into the next one, whatever it holds: a trailing comment with an apostrophe,
// a regex literal with a bracket, a block comment.
const js = (ac1) => `import { test, expect } from 'vitest';
test.fails('AC2: other child', () => { expect('(').toMatch(/[(]/); }); // the child isn't done
${ac1}('AC1: mine', () => { /* it's here */ expect(1).toBe(1); });
`;
t('a trailing comment or regex does not make a sibling spec read as changed', S(child('K-1', 'a.spec.ts', js('test.fails'), js('test'))), '[]');
t('each JS body is its own declaration', declarations('a.spec.ts', js('test')).map((d) => d.body.split('\n').length).join(','), '1,1');
t('a change to the other child\'s spec is still named, with its owner', S(child('K-1', 'a.spec.ts', js('test'), js('test').replace('toMatch(/[(]/)', 'toMatch(/x/)'))),
  S(['"AC2: other child" in a.spec.ts is AC2\'s spec, owned by K-2: K-1 changed it']));
t('adding a spec beside another child\'s is not changing it', S(child('K-1', 'a.spec.ts', js('test'), `${js('test')}test('AC1: another of mine', () => {});\n`)), '[]');

// An owned spec must actually have to pass: no marker of any kind, and not skipped.
t('an owned spec left skipped is named', S(child('K-1', 'a.spec.ts', js('test.fails'), js('test.skip'))), S(['AC1: "AC1: mine" in a.spec.ts is still skipped']));
const py = (deco, assertion = 'assert done()') => `import pytest

@pytest.mark.xfail(strict=True)
def test_ac2_other(
    page,
    db,
):
    assert other()

${deco}
def test_ac1_mine():
    ${assertion}
`;
t('an owned spec left non-strict xfail is named', S(child('K-1', 'test_f.py', py('@pytest.mark.xfail(strict=True)'), py('@pytest.mark.xfail'))),
  S(['AC1: "test_ac1_mine" in test_f.py is still marked expected-fail']));
t('an owned spec left pytest skip is named', S(child('K-1', 'test_f.py', py('@pytest.mark.xfail(strict=True)'), py('@pytest.mark.skip'))),
  S(['AC1: "test_ac1_mine" in test_f.py is still skipped']));
t('an owned python spec unmarked is clean', S(child('K-1', 'test_f.py', py('@pytest.mark.xfail(strict=True)'), py('@pytest.mark.parametrize("x", [1])'))), '[]');
t('a wrapped signature keeps the function body in the spec', S(child('K-1', 'test_f.py', py('#'), py('#').replace('assert other()', 'assert other() is None'))),
  S(['"test_ac2_other" in test_f.py is AC2\'s spec, owned by K-2: K-1 changed it']));
const oneLine = (deco) => `import pytest

@pytest.mark.xfail(strict=True)
def test_ac2_other(): assert other()

${deco}
def test_ac1_mine(): assert done()
`;
t('a one-line test does not take the next test into its body', S(child('K-1', 'test_f.py', oneLine('@pytest.mark.xfail(strict=True)'), oneLine('#'))), '[]');
const nested = (assertion) => `def test_ac2_other():
    def test_helper():
        return 1
    ${assertion}
`;
t('a test defined inside another stays part of its body', S(child('K-3', 'test_f.py', nested('assert test_helper() == 1'), nested('assert test_helper() == 2'))),
  S(['"test_ac2_other" in test_f.py is AC2\'s spec, owned by K-2: K-3 changed it']));

// One id per run: runners join several differently.
t('the command takes one id', specsCommand('pnpm vitest run tests/acceptance -t "{ids}"', 'AC1'), 'pnpm vitest run tests/acceptance -t "AC1"');

// The base gate and a finished child's check both run an id's specs with runSpecs. A stub with-lock.sh
// records the lock, the directory it ran in and the command, and exits 3.
const tmp = realpathSync(scratch('spine-run-'));
const bin = join(tmp, 'bin');
const root = join(tmp, 'wt');
mkdirSync(bin);
mkdirSync(join(root, 'packages', 'app'), { recursive: true });
writeFileSync(join(bin, 'with-lock.sh'), `#!/bin/sh
lock=$1; shift
[ "$1" = --cwd ] && { cd "$2" || exit 9; shift 2; }
[ "$1" = -- ] && shift
printf '%s|%s|%s\\n' "$lock" "$(pwd -P)" "$3"
exit 3
`, { mode: 0o755 });
const ran = (item, id) => { const r = runSpecs({ bin, root, item, id }); return `${r.out.trim()} exit=${r.code} ok=${r.ok} command=${r.command}`; };
t('AC1/AC2: a row naming a directory runs the substituted command there, under the test lock, with its own exit',
  ran('packages/app: bunx vitest run specs -t "{ids}"', 'DoD1'),
  `test|${root}/packages/app|bunx vitest run specs -t "DoD1" exit=3 ok=false command=packages/app: bunx vitest run specs -t "DoD1"`);
t('AC4: a row with no directory runs in the worktree root as before',
  ran('pnpm vitest run tests/acceptance -t "{ids}"', 'AC2'),
  `test|${root}|pnpm vitest run tests/acceptance -t "AC2" exit=3 ok=false command=pnpm vitest run tests/acceptance -t "AC2"`);

// ---- two epics in one acceptance directory, both with a DoD5 -------------------------------------
// The run takes only the batch's files for the id, in place of the spec directory the command names
// (as its directory sees it), or of {files}; a command naming neither runs as configured.
const SPEC_DIR = 'packages/app/specs-it/acceptance/';
const mineFile = 'packages/app/specs-it/acceptance/sv-2/robin.itest.ts';
const scope = { dir: 'packages/app', specDir: SPEC_DIR, files: [mineFile] };
t('a scoped run takes only the batch\'s files, in place of the directory the command names',
  specsCommand('bunx vitest run specs-it/acceptance -t "{ids}"', 'DoD5', scope), 'bunx vitest run specs-it/acceptance/sv-2/robin.itest.ts -t "DoD5"');
t('a trailing slash or ./ on the named directory is the same directory',
  specsCommand('bunx vitest run ./specs-it/acceptance/ -t "{ids}"', 'DoD5', scope), 'bunx vitest run specs-it/acceptance/sv-2/robin.itest.ts -t "DoD5"');
t('{files} takes them where the command puts it, quoted where the shell needs it',
  specsCommand('jest {files} -t "{ids}"', 'DoD5', { dir: '.', specDir: 'tests/acceptance', files: ['tests/acceptance/(portal)/a b.test.ts'] }), 'jest \'tests/acceptance/(portal)/a b.test.ts\' -t "DoD5"');
t('a command naming neither runs as configured',
  specsCommand('bash tests/acceptance/run.sh {ids}', 'DoD5', { dir: '.', specDir: 'tests/acceptance/', files: ['tests/acceptance/x.ts'] }), 'bash tests/acceptance/run.sh DoD5');
t('a longer directory sharing the name is not the spec directory',
  specsCommand('vitest run specs-it/acceptance-old -t "{ids}"', 'DoD5', scope), 'vitest run specs-it/acceptance-old -t "DoD5"');
t('no scope: the command as configured, as before',
  specsCommand('bunx vitest run specs-it/acceptance -t "{ids}"', 'DoD5'), 'bunx vitest run specs-it/acceptance -t "DoD5"');
{
  const r = runSpecs({ bin, root, item: 'packages/app: bunx vitest run specs-it/acceptance -t "{ids}"', id: 'DoD5', scope: { specDir: SPEC_DIR, files: [mineFile] } });
  t('runSpecs narrows the run it makes, and its label, to the scope\'s files', `${r.out.trim()} command=${r.command}`,
    `test|${root}/packages/app|bunx vitest run specs-it/acceptance/sv-2/robin.itest.ts -t "DoD5" command=packages/app: bunx vitest run specs-it/acceptance/sv-2/robin.itest.ts -t "DoD5"`);
}

// A repo whose main holds an earlier epic's DoD5, still expected-fail, beside this batch's base (which
// added its own DoD5 and DoD6) and a child that owns this batch's DoD5 and made it pass.
const repo = join(tmp, 'repo');
mkdirSync(repo);
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: gitEnv });
const put = (path, text) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
const otherFile = 'packages/app/specs-it/acceptance/sv-1/dod5.itest.ts';
const spec = (mod, title) => `import { it } from 'vitest';\nit${mod}('${title}', () => {});\n`;
git('init', '-q', '-b', 'main');
put(otherFile, spec('.fails', 'DoD5: a published version cannot be updated'));
git('add', '-A'); git('commit', '-q', '-m', 'an earlier epic'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
git('checkout', '-q', '-b', 'feat/E');
put(mineFile, `${spec('.fails', 'DoD5: Robin can write only under metrics/ai-agents/')}${spec('.fails', 'DoD6: wrong shapes are refused')}`);
git('add', '-A'); git('commit', '-q', '-m', 'the spine'); git('update-ref', 'refs/remotes/origin/feat/E', 'HEAD');
git('checkout', '-q', '-b', 'task/K-5');
put(mineFile, `${spec('', 'DoD5: Robin can write only under metrics/ai-agents/')}${spec('.fails', 'DoD6: wrong shapes are refused')}`);
git('add', '-A'); git('commit', '-q', '-m', 'K-5 makes DoD5 pass');
const two = { DoD5: 'K-5', DoD6: 'K-6' };
const runs = [];
const stubRun = (id, sc) => { runs.push({ id, files: sc?.files ?? null }); return { ok: true, out: '', command: 'stub' }; };
t('the batch\'s own specs are those its base and the branch changed under the directory, not an earlier epic\'s',
  S(batchSpecPaths({ worktree: repo, source: 'main', base: 'feat/E', specDir: SPEC_DIR })), S([mineFile]));
git('checkout', '-q', 'feat/E');
t('the base gate reads them off the base\'s own head', S(batchSpecPaths({ worktree: repo, source: 'main', base: 'feat/E', baseRef: 'HEAD', specDir: SPEC_DIR })), S([mineFile]));
git('checkout', '-q', 'task/K-5');
t('no separate base: every spec under the directory counts, as before', batchSpecPaths({ worktree: repo, source: 'main', base: 'main', specDir: SPEC_DIR }), null);
{
  const c = checkChild({ worktree: repo, base: 'feat/E', source: 'main', specDir: SPEC_DIR, owners: two, key: 'K-5', run: stubRun });
  t('two epics, same DoD5: a child that made its own pass is not held to the earlier epic\'s', S(c), S({ ok: true, problems: [] }));
  t('and its run takes only its own DoD5\'s file', S(runs), S([{ id: 'DoD5', files: [mineFile] }]));
}
{
  // K-6's branch, as it stands on the base: nothing done yet.
  git('checkout', '-q', '-b', 'task/K-6', 'feat/E');
  const c = checkChild({ worktree: repo, base: 'feat/E', source: 'main', specDir: SPEC_DIR, owners: two, key: 'K-6', run: stubRun });
  git('checkout', '-q', 'task/K-5');
  t('a child that left its own spec marked is named for that one alone', S(c.problems), S([`DoD6: "DoD6: wrong shapes are refused" in ${mineFile} is still marked expected-fail`]));
}
{
  const c = checkChild({ worktree: repo, base: 'feat/E', specDir: SPEC_DIR, owners: two, key: 'K-5', run: stubRun });
  t('with no default branch to tell the base\'s specs by, the whole directory counts, as before', S(c.problems),
    S([`DoD5: "DoD5: a published version cannot be updated" in ${otherFile} is still marked expected-fail`]));
}
rmSync(tmp, { recursive: true, force: true });

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
