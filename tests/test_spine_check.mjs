// suite: spine check (a feature child's owned specs, and the specs it must leave alone)
import { declarations, scanChild, specsCommand } from '../desk/bin/spine-check.mjs';
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

// One id per run: runners join several differently.
t('the command takes one id', specsCommand('pnpm vitest run tests/acceptance -t "{ids}"', 'AC1'), 'pnpm vitest run tests/acceptance -t "AC1"');

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
