// suite: baseline checks (record a base's typecheck and lint errors, fail a worker only on new ones)
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTsc, parseEslint, parseMypy, readRun, recordBaseline, readBaseline, compareRun, activeBaseline, summary } from '../desk/bin/baseline.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

// ---- fixtures, in each tool's own output format ----
const TSC = [
  'src/a.ts(3,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
  'src/b.ts(10,1): error TS2304: Cannot find name \'foo\'.',
  '  The elaboration on a continuation line is part of the error above.',
  '',
  'Found 2 errors in 2 files.',
].join('\n');
const TSC_PRETTY = [
  '\x1b[96msrc/a.ts\x1b[0m:\x1b[93m3\x1b[0m:\x1b[93m5\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2322: \x1b[0mType \'string\' is not assignable to type \'number\'.',
  '',
  '3 const x: number = "a";',
  '',
  'Found 1 error in src/a.ts:3',
].join('\n');
const eslint = (root) => [
  `${root}/src/a.js`,
  '  1:7   error    \'x\' is assigned a value but never used  no-unused-vars',
  '  2:1   warning  Unexpected console statement            no-console',
  '',
  `${root}/src/b.js`,
  '  4:9  error  Parsing error: Unexpected token',
  '',
  '✖ 3 problems (2 errors, 1 warning)',
].join('\n');
const MYPY = [
  'app/a.py:3: error: Incompatible types in assignment (expression has type "str", variable has type "int")  [assignment]',
  'app/a.py:9:5: error: Name "foo" is not defined  [name-defined]',
  'app/a.py:9: note: See https://mypy.rtfd.io',
  'Found 2 errors in 1 file (checked 4 source files)',
].join('\n');

// ---- parsers ----
const tsc = parseTsc(TSC);
t('tsc: plain format, two errors', tsc.problems.length, 2);
t('tsc: file, rule and message', `${tsc.problems[0].file}|${tsc.problems[0].rule}|${tsc.problems[0].message}`, 'src/a.ts|TS2322|Type \'string\' is not assignable to type \'number\'.');
t('tsc: the summary count', tsc.total, 2);
const pretty = parseTsc(TSC_PRETTY);
t('tsc --pretty: read through the colour codes', `${pretty.problems.length}|${pretty.problems[0].file}|${pretty.problems[0].rule}|${pretty.total}`, '1|src/a.ts|TS2322|1');
const es = parseEslint(eslint('/w'));
t('eslint: errors and warnings', es.problems.length, 3);
t('eslint: the file header applies to its rows', `${es.problems[1].file}|${es.problems[1].rule}|${es.problems[1].message}`, '/w/src/a.js|no-console|Unexpected console statement');
t('eslint: a parsing error has no rule', `${es.problems[2].rule}|${es.problems[2].message}`, '|Parsing error: Unexpected token');
t('eslint: the summary count', es.total, 3);
const my = parseMypy(MYPY);
t('mypy: errors with and without a column, notes left out', my.problems.length, 2);
t('mypy: the code is the rule', `${my.problems[1].rule}|${my.problems[1].message}`, 'name-defined|Name "foo" is not defined');
t('mypy: the summary count', my.total, 2);
t('mypy: success reads as none', readRun({ out: 'Success: no issues found in 4 source files', code: 0 }).problems.length, 0);

// ---- record (AC1) ----
const dir = mkdtempSync(join(tmpdir(), 'baseline-'));
const runs = { typecheck: { out: TSC, code: 2 }, lint: { out: eslint('/base'), code: 1 } };
const b = recordBaseline({
  stateDir: dir, root: '/base', base: 'feat/x', sha: 'a'.repeat(40),
  items: { typecheck: [{ dir: '.', cmd: 'pnpm tsc' }], lint: [{ dir: '.', cmd: 'pnpm lint' }] },
  run: ({ name }) => runs[name],
});
t('AC1 the baseline is written', existsSync(join(dir, 'baseline.json')) && readBaseline(dir).sha, 'a'.repeat(40));
t('AC1 the summary gives the counts', summary(b), 'typecheck 2 error(s) · lint 3 error(s)');
t('AC1 eslint paths are kept relative to the worktree', Object.keys(b.checks.lint[0].errors)[0].split('\t')[0], 'src/a.js');

// ---- compare ----
const cmp = (name, out, code, root = '/w') => compareRun({ entry: b.checks[name][0], run: { out, code }, root, dir: '.', cmd: b.checks[name][0].cmd });
const moved = TSC.replace('(3,5)', '(40,2)').replace('(10,1)', '(1,1)');
let r = cmp('typecheck', moved, 2);
t('AC2 only the recorded errors, at other lines: pass', `${r.pass}|${r.full}`, 'true|false');
t('AC2 it says the errors were already there', r.lines[0], 'PASS pnpm tsc: only the 2 error(s) the base already has');
r = cmp('lint', eslint('/w'), 1);
t('AC2 eslint from another worktree compares equal', r.pass, true);
r = cmp('typecheck', '', 0);
t('a clean run passes', r.pass, true);

const added = TSC.replace('Found 2 errors in 2 files.', 'src/untouched.ts(1,1): error TS2304: Cannot find name \'bar\'.\nFound 3 errors in 3 files.');
r = cmp('typecheck', added, 2);
t('AC3 a new error in any file fails', `${r.pass}|${r.full}`, 'false|false');
t('AC3 it names the new error', r.lines.slice(1).join('\n'), '  src/untouched.ts:1  TS2304  Cannot find name \'bar\'.');

const twice = TSC.replace('Found 2 errors in 2 files.', 'src/b.ts(12,1): error TS2304: Cannot find name \'foo\'.\nFound 3 errors in 2 files.');
r = cmp('typecheck', twice, 2);
t('AC4 a second identical error in one file fails', r.pass, false);
t('AC4 on the extra one only', `${r.lines.length}|${r.lines[1]}`, '2|  src/b.ts:12  TS2304  Cannot find name \'foo\'.');

r = cmp('typecheck', 'Segmentation fault (core dumped)', 139);
t('AC6 unreadable output falls back to the full check', `${r.pass}|${r.full}`, 'false|true');
t('AC6 and says so', /^FULL pnpm tsc: this run's output could not be read .*, so this is the full check \(exit 139\)$/.test(r.lines[0]), true);
t('AC6 the full output follows', r.lines[1], 'Segmentation fault (core dumped)');
r = cmp('typecheck', TSC.replace('Found 2 errors', 'Found 5 errors'), 2);
t('AC6 a parse that misses errors the tool counted is unreadable', `${r.full}|${/reported 5 problem\(s\) but 2 could be read/.test(r.lines[0])}`, 'true|true');
r = compareRun({ entry: { dir: '.', cmd: 'x', ok: false, why: 'it exited 1 and printed nothing read as tsc, ESLint or mypy output' }, run: { out: TSC, code: 2 }, root: '/w', dir: '.', cmd: 'x' });
t('AC6 a base that could not be read runs in full', `${r.full}|${r.pass}|${/the base's output could not be read/.test(r.lines[0])}`, 'true|false|true');
r = compareRun({ entry: undefined, run: { out: TSC, code: 2 }, root: '/w', dir: '.', cmd: 'other' });
t('a command the baseline never ran runs in full', r.full, true);
const bad = recordBaseline({ stateDir: dir, root: '/base', base: 'feat/x', sha: 'b'.repeat(40), items: { typecheck: [{ dir: '.', cmd: 'x' }] }, run: () => ({ out: 'boom', code: 1 }) });
t('AC6 the report names a check it could not read', /^typecheck unreadable \(x: .*\), so workers run it in full$/.test(summary(bad)), true);

const mb = recordBaseline({ stateDir: dir, root: '/base', base: 'feat/x', sha: 'c'.repeat(40), items: { typecheck: [{ dir: 'apps/api', cmd: 'uv run mypy .' }] }, run: () => ({ out: MYPY, code: 1 }) });
r = compareRun({ entry: mb.checks.typecheck[0], run: { out: `${MYPY.replace('Found 2', 'app/b.py:1: error: Missing return statement  [return]\nFound 3')}`, code: 1 }, root: '/w', dir: 'apps/api', cmd: 'uv run mypy .' });
t('mypy in a directory: the new error is named, relative to the root', r.lines[1], '  apps/api/app/b.py:1  return  Missing return statement');

// ---- when it applies (AC7) ----
t('AC7 off reads as the full check', activeBaseline({ setting: 'off', base: 'feat/x', stateDir: dir }).on, false);
t('AC7 unset reads as off', /unset, not on/.test(activeBaseline({ setting: null, base: 'feat/x', stateDir: dir }).why), true);
t('AC7 no batch base reads as the full check', activeBaseline({ setting: 'on', base: null, stateDir: dir }).why, 'this batch has no base');
t('a baseline from another base does not apply', activeBaseline({ setting: 'on', base: 'feat/y', stateDir: dir }).on, false);
t('on, with a base and its baseline, compares', activeBaseline({ setting: 'on', base: 'feat/x', stateDir: dir }).on, true);
t('nothing recorded yet reads as the full check', activeBaseline({ setting: 'on', base: 'feat/x', stateDir: join(dir, 'none') }).why, 'no baseline has been recorded yet');

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
