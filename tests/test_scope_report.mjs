// suite: scope report (files a worker changed outside its triaged scope)
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { incidentalGlobs, outOfScope, triagedScope, changedFiles, batchScopeTotals } from '../desk/bin/scope-report.mjs';
import { LOCKFILES } from '../desk/bin/test-scope.mjs';
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
const dir = mkdtempSync(join(tmpdir(), 'scope-'));
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

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
