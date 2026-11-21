// suite: desk-env tree-status (git status without the files desk skills leave untracked, and a review run's scratch)
// covers: desk/bin/desk-env.mjs skills/desk-review/references/phase-0-preflight.md skills/desk-review/references/phase-3-find.md skills/desk-ticket/references/stage-4b-self-review.md
// The real CLI in a scratch git repo with a linked worktree.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KNOWN_UNTRACKED, treeStatus } from '../desk/bin/desk-env.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const S = scratch('tree-status-');
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const repo = join(S, 'repo'), wt = join(S, 'wt');
mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
writeFileSync(join(repo, 'a.txt'), 'a\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'init');
git(repo, 'worktree', 'add', '-q', '-b', 'fix/T-1', wt);
const run = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [join(root, 'desk/bin/desk-env.mjs'), 'tree-status', ...args], {
    encoding: 'utf8', cwd, env: { ...process.env, HOME: S, DESK_CONFIG: join(S, 'none.md') },
  });
  return { status: r.status, out: r.stdout.trim() };
};
const resume = '.claude/desk-ticket-T-1.json';
const write = (p, s = '{}\n') => { mkdirSync(dirname(join(wt, p)), { recursive: true }); writeFileSync(join(wt, p), s); };

t('the known list holds desk-ticket\'s resume file', KNOWN_UNTRACKED.map((k) => k.path), ['.claude/desk-ticket-<TICKET>.json']);
t('a clean worktree prints nothing and exits 0', run(wt), { status: 0, out: '' });

write(resume);
t('AC1 a worktree whose only untracked entry is the resume file passes', run(wt), { status: 0, out: '' });

write('notes.txt', 'x\n');
t('AC2 an untracked file beside it is named, and the resume file is not', run(wt), { status: 1, out: '?? notes.txt' });
git(wt, 'clean', '-fq', 'notes.txt');
writeFileSync(join(wt, 'a.txt'), 'b\n');
t('AC2 a modified file beside it is named, and the resume file is not', run(wt), { status: 1, out: 'M a.txt' });
git(wt, 'checkout', '-q', '--', 'a.txt');

const id = 'a7b84ca-k3q9xz';
for (const f of [`desk-review-codex-brief-${id}.txt`, `desk-review-security-brief-${id}.txt`, `desk-review-results-${id}.json`, 'desk-review.md']) write(f);
t('AC3 the resume file and the run\'s own scratch files leave the round-end check clean', run(wt, '--run', id), { status: 0, out: '' });
write('desk-review-codex-brief-other1-zzzzzz.txt');
t('AC3 another run\'s scratch file is a change to this run', run(wt, '--run', id), { status: 1, out: '?? desk-review-codex-brief-other1-zzzzzz.txt' });
git(wt, 'clean', '-fq', 'desk-review-codex-brief-other1-zzzzzz.txt');
t('without --run the scratch files are changes, as Phase 0 needs', run(wt).out.split('\n').length, 4);
git(wt, 'clean', '-fq', '-e', '.claude');

write('.claude/settings.local.json');
t('another file under .claude is a change', run(wt), { status: 1, out: '?? .claude/settings.local.json' });
write('.claude/sub/desk-ticket-T-1.json');
t('the resume file\'s name one directory down is a change', run(wt).out.includes('?? .claude/sub/desk-ticket-T-1.json'), true);

t('--run with no id is a usage error', run(wt, '--run').status, 2);
t('an unknown argument is a usage error', run(wt, 'extra').status, 2);
mkdirSync(join(S, 'bare'));
t('outside a git work tree exits 3', run(join(S, 'bare')).status, 3);

t('treeStatus keeps a tracked change to a path shaped like the resume file', treeStatus(` M ${resume}\n?? ${resume}\n`), [` M ${resume}`]);
t('treeStatus reads a run id as text, not a pattern', treeStatus('?? desk-review-results-aXb.json\n', { run: 'a.b' }), ['?? desk-review-results-aXb.json']);

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
