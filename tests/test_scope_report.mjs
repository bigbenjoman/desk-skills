// suite: scope report (files a worker changed outside its triaged scope)
// claims: imports (repo file names below are test data, not what this suite runs)
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { incidentalGlobs, outOfScope, triagedScope, changedFiles, batchScopeTotals } from '../desk/bin/scope-report.mjs';
import { LOCKFILES } from '../desk/bin/test-scope.mjs';
import { scopeRecords, joinTickets, measure, proposeK, run, RULE, K_CAP } from '../desk/bin/scope-precision.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const S = (xs) => JSON.stringify(xs);

const scope = ['desk/bin/pass.mjs', 'desk/bin/scope-report.mjs', 'skills/desk-autopilot/'];
const lock = incidentalGlobs(null);

// AC1: in scope, test files and incidental paths are never reported.
t('AC1 only scoped files', S(outOfScope(['desk/bin/pass.mjs', 'desk/bin/scope-report.mjs'], scope, lock)), '[]');
t('AC1 a directory entry covers what is under it', S(outOfScope(['skills/desk-autopilot/references/x.md'], scope, lock)), '[]');
t('AC1 test files anywhere', S(outOfScope(['tests/test_x.sh', 'test/a.py', 'src/a.test.ts', 'apps/web/b.spec.tsx'], scope, lock)), '[]');
t('AC1 a lockfile at any depth', S(outOfScope(['pnpm-lock.yaml', 'apps/api/uv.lock'], scope, lock)), '[]');
t('AC1 a configured incidental glob', S(outOfScope(['docs/a.md'], scope, incidentalGlobs(['docs/**']))), '[]');
t('AC1 a ./ scope entry', S(outOfScope(['README.md'], ['./README.md'], lock)), '[]');

// AC2: everything else is listed, each file once, in diff order.
t('AC2 out-of-scope files listed', S(outOfScope(['desk/bin/pass.mjs', 'README.md', 'desk/bin/gate.mjs', 'README.md'], scope, lock)), '["README.md","desk/bin/gate.mjs"]');
t('AC2 a scope file is exact, not a basename', S(outOfScope(['other/pass.mjs'], scope, lock)), '["other/pass.mjs"]');
t('AC2 a nested tests dir is not a test glob', S(outOfScope(['apps/api/tests/helpers.py'], scope, lock)), '["apps/api/tests/helpers.py"]');
t('AC2 no scope at all reports every non-test file', S(outOfScope(['a.js', 'a.test.js'], [], lock)), '["a.js"]');
t('AC2 a set row replaces the lockfile default', S(outOfScope(['pnpm-lock.yaml'], scope, incidentalGlobs(['docs/**']))), '["pnpm-lock.yaml"]');
t('AC2 none leaves only test files incidental', S(outOfScope(['pnpm-lock.yaml', 'x.spec.js'], scope, incidentalGlobs(['none']))), '["pnpm-lock.yaml"]');

// AC4: an unset row reads as the lockfiles.
t('AC4 unset row is the lockfiles', S(incidentalGlobs(null)), S([...LOCKFILES]));
t('AC4 every lockfile is incidental at any depth', S(outOfScope(['package-lock.json', 'yarn.lock', 'poetry.lock', 'a/Cargo.lock', 'b/c/go.sum'], [], incidentalGlobs(null))), '[]');

// AC3: the batch total counts tickets with any file and the files in all; unchecked tickets are not counted.
const totals = batchScopeTotals([{ out_of_scope: ['a', 'b'] }, { out_of_scope: [] }, { out_of_scope: ['c'] }, { out_of_scope: null }, {}]);
t('AC3 batch totals', S(totals), '{"checked":3,"tickets":2,"files":3}');
t('AC3 empty batch', S(batchScopeTotals([])), '{"checked":0,"tickets":0,"files":0}');

// The triage record and the diff, from fixtures.
const dir = scratch('scope-');
mkdirSync(join(dir, 'triage'));
writeFileSync(join(dir, 'triage', 'T-1.json'), JSON.stringify({ ticket: 'T-1', files_in_scope: ['a.js'] }));
writeFileSync(join(dir, 'triage', 'T-2.json'), '{not json');
t('triage scope read', S(triagedScope(dir, 'T-1')), '["a.js"]');
t('no triage record is null', triagedScope(dir, 'T-9'), null);
t('unreadable triage record is null', triagedScope(dir, 'T-2'), null);

const repo = join(dir, 'repo');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } });
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
writeFileSync(join(repo, 'a.js'), '1\n'); writeFileSync(join(repo, 'old.js'), 'moved\n');
git('add', '.'); git('commit', '-q', '-m', 'base');
git('update-ref', 'refs/remotes/origin/main', 'HEAD');
git('checkout', '-q', '-b', 'feat/T-1');
writeFileSync(join(repo, 'a.js'), '2\n'); git('mv', 'old.js', 'new.js');
git('add', '.'); git('commit', '-q', '-m', 'work');
// The default branch moves on after the branch was cut: its commits are not the worker's.
git('checkout', '-q', 'main'); writeFileSync(join(repo, 'other.js'), 'x\n'); git('add', '.'); git('commit', '-q', '-m', 'other');
git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('checkout', '-q', 'feat/T-1');
const changed = changedFiles(repo, 'origin/main');
t('diff names both sides of a rename and not the base\'s commits', S([...changed].sort()), '["a.js","new.js","old.js"]');
t('end to end: the rename is reported', S(outOfScope(changed, triagedScope(dir, 'T-1'), lock).sort()), '["new.js","old.js"]');
t('no such worktree is null', changedFiles(join(dir, 'nope'), 'origin/main'), null);

// Scope precision: the triage records joined with the files of the merged PRs that name their key.
const st = join(dir, 'state');
mkdirSync(join(st, 'triage'), { recursive: true }); mkdirSync(join(st, 'batches/E-1/triage'), { recursive: true });
writeFileSync(join(st, 'triage', 'T-1.json'), JSON.stringify({ files_in_scope: ['./a.js', 'a.js', 'lib/'] }));
writeFileSync(join(st, 'triage', 'T-1.challenge.json'), JSON.stringify({ files_in_scope: ['x.js'] }));
writeFileSync(join(st, 'triage', 'T-3.json'), '{not json');
writeFileSync(join(st, 'batches/E-1/triage', 'T-1.json'), JSON.stringify({ files_in_scope: ['batch.js'] }));
writeFileSync(join(st, 'batches/E-1/triage', 'T-2.json'), JSON.stringify({ files_in_scope: ['b.js'] }));
const recs = scopeRecords(st);
t('records: the standing batch wins, a named batch adds, ./ and repeats folded, challenges and bad JSON skipped',
  S([...recs]), '[["T-1",["a.js","lib/"]],["T-2",["b.js"]]]');
t('records: no state folder is none', scopeRecords(join(dir, 'nope')).size, 0);

const joined = joinTickets(new Map([['T-1', ['a.js']], ['T-12', ['c.js']], ['T-2', ['b.js']]]), [
  { headRefName: 'feat/T-12-x', title: 'feat: T-12 x', files: ['c.js'] },
  { headRefName: 'feat/T-1-y', title: 'feat: y', files: ['a.js', 'd.js'] },
  { headRefName: 'fix/z', title: 'fix(x): T-1 follow-up', files: ['./e.js', 'a.js'] },
]);
t('join: a key is matched whole, by branch or title, its PRs\' files unioned, and an unmerged key dropped',
  S(joined), '[{"key":"T-1","named":["a.js"],"changed":["a.js","d.js","e.js"]},{"key":"T-12","named":["c.js"],"changed":["c.js"]}]');

const m = measure([
  { key: 'A-1', named: ['hot.js', 'lib/', 'cold.js'], changed: ['hot.js', 'lib/x.js', 'other.js'] },
  { key: 'A-2', named: ['hot.js', 'cold.js'], changed: ['hot.js'] },
  { key: 'A-3', named: ['cold.js'], changed: ['cold.js', 'hot.js'] },
], 2);
t('measure: overall counts', S({ ...m, files: undefined }), '{"tickets":3,"named":6,"hits":4,"changed":6,"covered":4}');
t('measure: the most-named files, most named first, each with the tickets that changed it',
  S(m.files), '[{"file":"cold.js","named":3,"hits":1,"changed":1},{"file":"hot.js","named":2,"hits":2,"changed":3}]');
t('measure: a directory entry is changed by a file under it', S(measure(
  [{ key: 'A-1', named: ['lib/'], changed: ['lib/x.js', 'lib/y.js'] }]).files), '[{"file":"lib/","named":1,"hits":1,"changed":1}]');

t('k: 80% changed is 1', proposeK(4, 5), 1);
t('k: just under 80% is 2', proposeK(79, 100), 2);
t('k: half is 2', proposeK(1, 2), 2);
t('k: 40% is 3', proposeK(2, 5), 3);
t('k: the cap is the default row\'s long-file k', K_CAP, 3);
t('k: rare is capped', proposeK(1, 10), K_CAP);
t('k: never changed is the cap', proposeK(0, 4), K_CAP);

const out = run(['o/r', 'o/s'], {
  days: 30, now: Date.parse('2026-11-21T12:00:00Z'),
  records: (r) => (r === 'o/r' ? new Map([['R-1', ['hot.js', 'cold.js']], ['R-2', ['hot.js']]]) : new Map()),
  prs: (r, since) => (r === 'o/r' && since === '2026-10-22' ? [{ headRefName: 'feat/R-1', title: '', files: ['hot.js'] }, { headRefName: 'feat/R-2', title: '', files: ['hot.js', 'x.js'] }] : []),
}).split('\n');
t('run: each repo\'s precision and recall overall', out.filter((l) => /^ {2}precision/.test(l)).join('|'),
  '  precision 67% (2 of 3 named files changed), recall 67% (2 of 3 changed files named)|  precision n/a (0 of 0 named files changed), recall n/a (0 of 0 changed files named)');
t('run: each most-named file\'s counts', out.filter((l) => /^ {4}/.test(l)).join('|'), '    hot.js: 2  2  100%  100%|    cold.js: 1  0  0%  n/a');
t('run: it ends with a k per file and a hot-serial list for every repo', out.slice(out.findIndex((l) => l.startsWith('Proposed'))).slice(1).join('|'),
  'o/r:|  hot.js: k=1 (2 of 2 naming tickets changed it)|  cold.js: k=3 (0 of 1 naming tickets changed it)|  hot-serial: hot.js|o/s:|  hot-serial: none');
t('run: the rule is printed beside the numbers', out.some((l) => l.startsWith('Proposed') && l.includes(RULE)), true);

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
