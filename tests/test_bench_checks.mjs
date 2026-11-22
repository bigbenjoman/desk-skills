// suite: bench checks (the checks a merged PR added or changed, and how many of them a run passed)
// layer: L2
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { helpersIn, changedAt, suiteLabel, findChecks, suiteSections, suiteCounts, tallyChecks } from '../desk/bin/bench-checks.mjs';
import { addedChecks } from '../desk/bin/bench-build.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

// The helpers: a one-line definition that prints FAIL, in JS or bash.
const JS_T = "const t = (name, got, want) => { const ok = got === want; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}`); };";
const SH_CHECK = 'check(){ if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fi; }';
t('a JS helper that prints a failure line is found', [...helpersIn(JS_T)].join(','), 't');
t('a bash helper that prints a failure line is found', [...helpersIn(SH_CHECK)].join(','), 'check');
t('a failure counter is no helper', helpersIn('PASS=0; FAIL=0\nconst FAILED = new Set([1]);').size, 0);
t('a suite label is its suite: line', suiteLabel('// suite: widgets (all of them)\nimport x;', 'tests/test_w.mjs'), 'widgets (all of them)');
t('else its file name', suiteLabel('import x;', 'tests/test_w.mjs'), 'test_w.mjs');
t('a diff gives the merge side\'s changed lines, and a removal between two',
  JSON.stringify([...changedAt('--- a/x\n+++ b/tests/x.mjs\n@@ -1 +1 @@\n-old\n+new\n@@ -5,2 +5,2 @@\n-a\n-b\n+c\n+d\n@@ -9 +8,0 @@\n-gone\n')]), '[["tests/x.mjs",[1,5,6,8.5]]]');

// AC1: a real PR that adds two checks and changes one, in a JS suite, and adds a bash check beside a
// sourced helper. A check it leaves alone, a templated name and a call that is no check are not counted.
const dir = realpathSync(scratch('bench-checks-test-'));
const repo = join(dir, 'repo');
const gitEnv = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
for (const k of Object.keys(gitEnv)) if (/^(GIT_DIR$|GIT_WORK_TREE$)/.test(k)) delete gitEnv[k];
writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { env: gitEnv, encoding: 'utf8' }).trim();
const commit = (files) => {
  for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), body); }
  git('add', '-A'); git('commit', '-q', '-m', 'c');
  return git('rev-parse', 'HEAD');
};
mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv });
const JS_BASE = `// suite: widgets\n${JS_T}\nt('kept', 1, 1);\nt('changed', f(), 1);\nt('kept too (two lines)',\n  k(), 1);\nt('changed below',\n  j(), 1);\nt('kept last', 1, 1);\n`;
const JS_MERGE = `// suite: widgets\n${JS_T}\nt('kept', 1, 1);\nt('changed', f(), 2);\nt("added one", g(), 3);\nconsole.log('note');\nfor (const x of xs) t(\`\${x}\`, x, x);\nt(\`added \${n} two\`, h(), 4);\nt('kept too (two lines)',\n  k(), 1);\nt('changed below',\n  j(), 2);\nt('kept last', 1, 1);\n`;
const SH_CONT = (f) => `check "continued in bash" \\\n  '[ -f ${f} ]'\ncheck "after it" '[ -f z ]'\n`;
const base = commit({ 'tests/test_w.mjs': JS_BASE, 'tests/setup.sh': `${SH_CHECK}\n`, 'tests/test_s.sh': `. tests/setup.sh\n${SH_CONT('a')}` });
const merge = commit({ 'tests/test_w.mjs': JS_MERGE, 'tests/test_s.sh': `. tests/setup.sh\n${SH_CONT('b')}check "AC1 the $thing is there" '[ -f x ]'\n` });
const hidden = join(dir, 'hidden');
for (const [f, body] of [['tests/test_w.mjs', JS_MERGE], ['tests/test_s.sh', git('show', `${merge}:tests/test_s.sh`)]]) {
  mkdirSync(dirname(join(hidden, f)), { recursive: true }); writeFileSync(join(hidden, f), body);
}
const found = addedChecks(repo, base, merge, ['tests/test_s.sh', 'tests/test_w.mjs'], hidden);
const names = found.checks.map((c) => `${c.suite}/${c.name}`).sort();
t('AC1 the task records the checks the PR added or changed', JSON.stringify(names), JSON.stringify(['test_s.sh/AC1 the … is there', 'test_s.sh/continued in bash', 'widgets/added one', 'widgets/added … two', 'widgets/changed', 'widgets/changed below']));
t('AC1 a check the PR left alone is not one', names.some((n) => /\/kept/.test(n)), false);
t('AC1 with no why when it found some', found.why, undefined);
const none = findChecks({ diff: '+++ b/tests/test_w.mjs\n+t(\'x y z\', 1, 1)\n', defs: '', texts: { 'tests/test_w.mjs': '' } });
t('no helper beside the tests: none, with why', none.checks.length === 0 && /no check helper/.test(none.why), true);

// AC2: tests/run.sh's output, where the arm fails one of the three JS checks and passes the bash one.
const checks = found.checks;
const section = (label, body, ok = 5) => `\n== ${label}\nok: ${ok}\ntook: 1 s\ncpu: 0.100 s${body}\n`;
// At the merge every check passes: the bash suite runs 1, the JS suite 6.
const MERGE_RUN = `$ bash tests/run.sh 'tests/test_s.sh' 'tests/test_w.mjs'\n${section('test_s.sh', '', 3)}${section('widgets', '', 6)}\n\nall passed: 9 checks\n\nexit 0\n`;
const suites = suiteCounts(MERGE_RUN);
t('each suite\'s check count is read off the merge run', JSON.stringify(suites), '{"test_s.sh":3,"widgets":6}');
const RUN = `$ bash tests/run.sh 'tests/test_s.sh' 'tests/test_w.mjs'\n${section('test_s.sh', '', 3)}${section('widgets', '\nexit 1\nFAIL added 7 two: 5 (want 4)\nok   nothing')}\n\nFAILURES above (6 checks passed)\nfailed suites: test_w.mjs\n\nexit 1\n`;
t('AC2 a failing check is read off its failure line', JSON.stringify(tallyChecks({ checks, suites }, RUN)), '{"passed":5,"of":6}');
const widgets = { checks: checks.filter((c) => c.suite === 'widgets'), suites };
t('AC2 the arm passes three of the four JS checks', JSON.stringify(tallyChecks(widgets, RUN)), '{"passed":3,"of":4}');
const unread = (log, added = widgets) => { const r = tallyChecks(added, log); return r.passed === null && r.of === 4 ? r.why : JSON.stringify(r); };
t('AC2 a check that printed a stack trace from the code it tests, in a suite that ran to its end, is measured',
  JSON.stringify(tallyChecks(widgets, section('widgets', '\nexit 1\nFAIL changed: out: TypeError: boom\n    at main (file:///w/x.mjs:12:9)'))), '{"passed":3,"of":4}');
t('AC3 a suite that named one failure, then stopped: not measured, its unrun checks never counted',
  unread(section('widgets', '\nexit 1\nFAIL added 7 two: 5 (want 4)\nTypeError: boom', 2)), 'the hidden tests did not finish: suite widgets ran 3 of its 6');
t('AC3 a suite killed after one failure: not measured', unread(section('widgets', '\nexit 137\nFAIL changed: 1 (want 2)', 3)), 'the hidden tests did not finish: suite widgets ran 4 of its 6');
t('AC3 with no count recorded, a suite that failed naming no check: not measured, never 0',
  unread(section('widgets', '\nexit 1\nTypeError: boom', 0), { checks: widgets.checks }), 'the hidden tests did not finish: suite widgets ran 0 of its checks');
t('a suite that is not in the output: not measured', unread(section('other', '')), 'the test output has no section for suite widgets');
t('a heading or trailer in a suite\'s own output opens and closes nothing',
  JSON.stringify(tallyChecks(widgets, section('widgets', '\nexit 1\nFAIL changed: out:\n== other\nall passed: 3 checks\nFAIL changed below: 1 (want 2)', 4))), '{"passed":2,"of":4}');
t('a retried suite\'s first run is not counted',
  JSON.stringify(tallyChecks(widgets, section('widgets', '\nretried: failed its first run, passed its retry\n-- first run\nexit 1\nFAIL changed: 1 (want 2)', 6))), '{"passed":4,"of":4}');
t('the trailer is no suite\'s', suiteSections(`${section('widgets', '')}\n\nFAILURES above\nexit 1\n`).get('widgets').failed, false);
const other = tallyChecks(widgets, 'PASS tests/w.test.ts\n  ✓ changed\n');
t('another runner\'s output is not measured, never 0', other.passed === null && /no tests\/run\.sh suite headings/.test(other.why), true);

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
