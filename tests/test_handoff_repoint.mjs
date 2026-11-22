// suite: handback and requeue re-point a ticket to its open PR's branch (queue.mjs handback and requeue, handoff.mjs repointToPr)
// layer: L2
// covers: desk/bin/handoff.mjs desk/bin/queue.mjs
// Each case is a throwaway origin and worktree, a queue under a throwaway DESK_HOME, and a fake gh whose
// `pr list` answers with $T/prs.json. Nothing touches your real ~/.claude, state or GitHub.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';
import { handoffTarget } from '../desk/bin/handoff.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('handoff-repoint-');
for (const k of Object.keys(process.env)) if (k.startsWith('DESK_') || k.startsWith('AUTOPILOT_')) delete process.env[k];

mkdirSync(join(T, 'bin'));
const PRS = join(T, 'prs.json');
// `gh pr list` answers with $T/prs.json, narrowed as GitHub's text search would with --search (titles
// only, never a branch); `gh pr view <n>` with that PR from $T/views.json, or fails.
const VIEWS = join(T, 'views.json');
writeFileSync(join(T, 'bin', 'gh'), `#!/bin/sh
[ "$1 $2" = "pr list" ] && exec ${JSON.stringify(process.execPath)} -e 'const a = process.argv.slice(2); const s = a.includes("--search") ? a[a.indexOf("--search") + 1] : null; const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(JSON.stringify(s ? l.filter((p) => String(p.title).includes(s)) : l))' ${JSON.stringify(PRS)} "$@"
[ "$1 $2" = "pr view" ] && exec ${JSON.stringify(process.execPath)} -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (!v) process.exit(1); console.log(JSON.stringify(v))' ${JSON.stringify(VIEWS)} "$3"
exit 1
`, { mode: 0o755 });
const prs = (list, views = {}) => { writeFileSync(PRS, JSON.stringify(list)); writeFileSync(VIEWS, JSON.stringify(views)); };
const view = (p, state = 'OPEN') => ({ [p.number]: { ...p, state } });
const state = join(T, 'state');
mkdirSync(state, { recursive: true });
const env = { ...process.env, HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_AUTOPILOT_STATE: state,
  DESK_QUEUE: join(T, 'queue.json'), DESK_GH_REPO: 'acme/widgets', DESK_LOCK_DIR: join(T, 'locks'), PATH: `${join(T, 'bin')}:${process.env.PATH}`,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });

const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (dir, msg) => git(dir, 'commit', '-q', '--allow-empty', '-m', msg);

// An origin holding main and the PR's branch `task/K-1-pr` one commit ahead of it, and a worktree cloned
// from it on the queued branch `task/K-1-old` at main (so behind the PR's head), or, when `queued` is
// false, detached at the PR's head with no branch of the queued name.
let n = 0;
function fixture({ queued = true, extra = false } = {}) {
  const dir = join(T, `case-${++n}`);
  const seed = join(dir, 'seed');
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  commit(seed, 'base');
  git(seed, 'checkout', '-q', '-b', 'task/K-1-pr');
  commit(seed, 'the PR work');
  git(seed, 'checkout', '-q', 'main');
  git(dir, 'clone', '-q', '--bare', seed, join(dir, 'origin.git'));
  const wt = join(dir, 'wt');
  git(dir, 'clone', '-q', join(dir, 'origin.git'), wt);
  if (queued) {
    git(wt, 'checkout', '-q', '-b', 'task/K-1-old', 'origin/main');
    if (extra) commit(wt, 'work only on the old branch');
  } else git(wt, 'checkout', '-q', '--detach', 'origin/task/K-1-pr');
  return wt;
}

const queue = (wt, extra = {}) => writeFileSync(env.DESK_QUEUE, JSON.stringify({ tickets: {
  'K-1': { state: 'parked', lane: 'C', park: { question: 'lane C: the plan needs agreeing', since: new Date().toISOString() }, branch: 'task/K-1-old', worktree: wt, ...extra },
} }));
const handback = () => spawnSync(process.execPath, [join(BIN, 'queue.mjs'), 'handback', 'K-1', 'plan agreed'], { env, encoding: 'utf8' });
const queued = () => JSON.parse(readFileSync(env.DESK_QUEUE, 'utf8')).tickets['K-1'];
const PR = { number: 861, title: 'refactor(pass): K-1 split', headRefName: 'task/K-1-pr', isCrossRepository: false };

// AC1: the queued branch is gone and its own PR is open on another branch.
const wt1 = fixture({ queued: false });
prs([PR]);
queue(wt1);
const r1 = handback();
t('AC1 a missing branch with its own PR open on another is handed back', r1.status, 0);
t('AC1 the queued branch becomes the PR\'s head', queued().branch, 'task/K-1-pr');
t('AC1 the worktree is on it', git(wt1, 'branch', '--show-current'), 'task/K-1-pr');
t('AC1 and the ticket resumes at Stage 4b', `${queued().state} ${queued().handoff_stage}`, 'triaged 4b');
t('AC1 the line says it was re-pointed', /re-pointed to its open PR #861's task\/K-1-pr/.test(r1.stdout), true);

// The same with the key only in the PR's branch, which GitHub's text search never reads: still found.
const wt1b = fixture({ queued: false });
prs([{ ...PR, title: 'refactor(pass): split the module' }]);
queue(wt1b);
t('AC1 a PR naming the ticket only in its branch is found though search would miss it', `${handback().status} ${queued().branch}`, '0 task/K-1-pr');

// AC2: the queued branch still exists, its worktree on it, with nothing the PR's head lacks; its PR is recorded.
const wt2 = fixture();
const old2 = git(wt2, 'rev-parse', 'HEAD');
prs([{ ...PR, number: 900, title: 'K-1 a second PR', headRefName: 'task/K-1-other' }], view({ ...PR, number: 862 }));
queue(wt2, { draft_pr: 862 });
const r2 = handback();
t('AC2 a queued branch with no commits outside the PR is handed back', r2.status, 0);
t('AC2 it is re-pointed to the recorded PR\'s head, read by number though the search missed it, not another naming the ticket', `${queued().branch} ${git(wt2, 'branch', '--show-current')}`, 'task/K-1-pr task/K-1-pr');
t('AC2 the old ref is kept as a backup', git(wt2, 'rev-parse', 'refs/heads/desk-backup/task/K-1-old'), old2);
t('AC2 and the queued name is gone', spawnSync('git', ['-C', wt2, 'rev-parse', '--verify', '-q', 'refs/heads/task/K-1-old']).status !== 0, true);

// AC3: the queued branch has a commit that is not on the PR's head.
const wt3 = fixture({ extra: true });
const sha3 = git(wt3, 'rev-parse', '--short', 'HEAD');
prs([PR], view(PR));
queue(wt3, { draft_pr: 861 });
const r3 = handback();
t('AC3 commits outside the PR refuse the handback', r3.status !== 0, true);
t('AC3 the refusal names those commits', r3.stderr.includes(`${sha3} work only on the old branch`), true);
t('AC3 nothing is re-pointed', `${queued().branch} ${queued().state} ${git(wt3, 'branch', '--show-current')}`, 'task/K-1-old parked task/K-1-old');

// AC4: no open PR, and the branch is missing: refused as before.
const wt4 = fixture({ queued: false });
prs([]);
queue(wt4);
const r4 = handback();
t('AC4 no open PR and a missing branch is refused as before', `${r4.status !== 0} ${/its branch task\/K-1-old no longer exists, so no worker can start it at Stage 4b/.test(r4.stderr)}`, 'true true');
t('AC4 and stays parked on its branch', `${queued().state} ${queued().branch}`, 'parked task/K-1-old');

// A PR from a fork, or two open PRs naming the ticket with none recorded, is not its own.
const wt5 = fixture({ queued: false });
prs([{ ...PR, isCrossRepository: true }]);
queue(wt5);
t('a fork\'s PR is never re-pointed to', `${handback().status !== 0} ${queued().branch}`, 'true task/K-1-old');
prs([PR, { ...PR, number: 900, headRefName: 'task/K-1-other' }]);
t('two PRs naming the ticket with none recorded re-point nothing', `${handback().status !== 0} ${queued().branch}`, 'true task/K-1-old');

// A recorded PR that has closed is not its own open PR: the one open PR naming the ticket is.
const wt6 = fixture({ queued: false });
prs([PR], view({ ...PR, number: 700, headRefName: 'task/K-1-closed' }, 'CLOSED'));
queue(wt6, { draft_pr: 700 });
t('a closed recorded PR gives way to the open one naming the ticket', `${handback().status} ${queued().branch}`, '0 task/K-1-pr');

// An unrecorded PR naming the ticket, the queued branch in place: re-pointed when the branch holds
// nothing the PR lacks, and handed back on its own branch as before when it holds work of its own.
const wt7 = fixture();
prs([PR]);
queue(wt7);
const r7 = handback();
t('an unrecorded PR re-points a queued branch with no work of its own', `${r7.status} ${queued().branch} ${git(wt7, 'branch', '--show-current')}`, '0 task/K-1-pr task/K-1-pr');
const wt8 = fixture({ extra: true });
queue(wt8);
const r8 = handback();
t('an unrecorded PR does not outrank a queued branch with work of its own', `${r8.status} ${queued().branch} ${git(wt8, 'branch', '--show-current')}`, '0 task/K-1-old task/K-1-old');
const wt8b = fixture();
prs([{ ...PR, number: 870, title: 'feat: K-2 builds on K-1', headRefName: 'feat/K-2-x' }]);
git(join(wt8b, '..', 'origin.git'), 'branch', 'feat/K-2-x', 'task/K-1-pr');
queue(wt8b);
t('an unrecorded PR naming the ticket only in its title leaves a queued branch in place alone', `${handback().status} ${queued().branch} ${git(wt8b, 'branch', '--show-current')}`, '0 task/K-1-old task/K-1-old');

// The PR's head has the queued branch's own name, but that branch is gone from the worktree: made again from origin.
const wt9 = fixture({ queued: false });
prs([{ ...PR, headRefName: 'task/K-1-old' }]);
git(join(wt9, '..', 'origin.git'), 'branch', 'task/K-1-old', 'task/K-1-pr');
queue(wt9);
t('a missing branch the PR still has on origin is made again', `${handback().status} ${queued().branch} ${git(wt9, 'branch', '--show-current')}`, '0 task/K-1-old task/K-1-old');

// A local copy of the PR's head: behind the PR it is brought up to it; diverged from it, refused before anything moves.
const wt10 = fixture({ queued: false });
git(wt10, 'branch', 'task/K-1-pr', 'origin/main');
prs([PR]);
queue(wt10);
t('a local copy behind the PR is brought up to it as it is checked out', `${handback().status} ${git(wt10, 'branch', '--show-current')} ${git(wt10, 'rev-parse', 'HEAD') === git(wt10, 'rev-parse', 'origin/task/K-1-pr')}`, '0 task/K-1-pr true');
const wt10b = fixture({ queued: false });
git(wt10b, 'checkout', '-q', '-b', 'task/K-1-pr', 'origin/main');
queue(wt10b);
t('a local copy behind the PR, already checked out, is fast-forwarded in place', `${handback().status} ${git(wt10b, 'rev-parse', 'HEAD') === git(wt10b, 'rev-parse', 'origin/task/K-1-pr')}`, '0 true');
const wt11 = fixture({ queued: false });
git(wt11, 'checkout', '-q', '-b', 'task/K-1-pr', 'origin/main');
commit(wt11, 'a stray local commit');
git(wt11, 'checkout', '-q', '--detach', 'origin/task/K-1-pr');
queue(wt11);
const r11 = handback();
t('a local copy diverged from the PR refuses, naming its commits', `${r11.status !== 0} ${/has diverged from it.*a stray local commit/.test(r11.stderr)} ${queued().branch}`, 'true true task/K-1-old');
t('and the worktree is left where it was', git(wt11, 'branch', '--show-current'), '');

// requeue refusing after the worktree moved: the queue still records the branch the worktree is now on.
const wt12 = fixture({ queued: false });
prs([PR]);
queue(wt12, { park: { question: 'lane C: the plan needs agreeing', since: new Date().toISOString(), session_step: { step: 'run the backfill' } } });
const r12 = handback();
t('a refused requeue after a re-point keeps the queue on the moved branch', `${r12.status !== 0} ${queued().branch} ${/Not requeued, but its branch task\/K-1-old re-pointed/.test(r12.stderr)}`, 'true task/K-1-pr true');

// requeue: a worker's own park (a conflict fix on its PR), lane B, re-pointed the same way before it goes back.
const requeue = (cmd = 'requeue') => spawnSync(process.execPath, [join(BIN, 'queue.mjs'), cmd, 'K-1'], { env, encoding: 'utf8' });
const parkedB = (extra = {}) => ({ lane: 'B', park: { question: 'PR #861 has a merge conflict with main', since: new Date().toISOString() }, ...extra });

// RQ AC1, AC2: queued on A, its recorded PR open on B, nothing on A that B lacks.
const rq1 = fixture();
const oldRq1 = git(rq1, 'rev-parse', 'HEAD');
prs([], view(PR));
queue(rq1, parkedB({ draft_pr: 861 }));
const rr1 = requeue();
t('RQ AC1 a requeue with its recorded PR open on another branch succeeds', rr1.status, 0);
t('RQ AC1 the queued branch becomes the PR\'s head, and the worktree is on it', `${queued().branch} ${git(rq1, 'branch', '--show-current')}`, 'task/K-1-pr task/K-1-pr');
t('RQ AC1 the old branch is kept as a backup ref', git(rq1, 'rev-parse', 'refs/heads/desk-backup/task/K-1-old'), oldRq1);
t('RQ AC1 the line says it was re-pointed', /re-pointed to its open PR #861's task\/K-1-pr, the old one kept as desk-backup\/task\/K-1-old/.test(rr1.stdout), true);
// The worker is spawned on the queued branch (pass.mjs hands it to setup-worktree.sh and the worker as
// AUTOPILOT_BRANCH), and setup-worktree.sh hands out a kept worktree only when it is on that branch.
t('RQ AC2 the ticket goes to a worker on B, in a worktree already on B', `${queued().state} ${handoffTarget({ worktree: rq1, branch: queued().branch })}`, 'triaged null');

// A requeue whose queue write was lost after the worktree moved: run again, it records the PR's branch.
queue(rq1, parkedB({ draft_pr: 861 }));
t('a requeue run again after a lost queue write records the branch the worktree moved to', `${requeue().status} ${queued().branch} ${git(rq1, 'branch', '--show-current')}`, '0 task/K-1-pr task/K-1-pr');

// RQ AC3: A holds a commit B lacks: nothing moves, the requeue still goes through and names the commit.
const rq3 = fixture({ extra: true });
const shaRq3 = git(rq3, 'rev-parse', '--short', 'HEAD');
prs([], view(PR));
queue(rq3, parkedB({ draft_pr: 861 }));
const rr3 = requeue();
t('RQ AC3 commits outside the PR leave the branch and worktree as they were', `${rr3.status} ${queued().state} ${queued().branch} ${git(rq3, 'branch', '--show-current')}`, '0 triaged task/K-1-old task/K-1-old');
t('RQ AC3 the requeue line names those commits', rr3.stdout.includes('left on its branch task/K-1-old') &&rr3.stdout.includes(`${shaRq3} work only on the old branch`), true);

// RQ AC4: no recorded PR (an unrecorded one naming the ticket is not read), or a recorded one no longer open.
const rq4 = fixture();
prs([PR]);
queue(rq4, parkedB());
const rr4 = requeue();
t('RQ AC4 no recorded PR leaves the branch as it was', `${rr4.status} ${queued().branch} ${git(rq4, 'branch', '--show-current')} ${/re-point/.test(rr4.stdout)}`, '0 task/K-1-old task/K-1-old false');
const rq4b = fixture();
prs([], view(PR, 'MERGED'));
queue(rq4b, parkedB({ draft_pr: 861 }));
t('RQ AC4 a recorded PR that is not open leaves the branch as it was', `${requeue().status} ${queued().branch} ${git(rq4b, 'branch', '--show-current')}`, '0 task/K-1-old task/K-1-old');

// The commands that requeue on the person's behalf re-point too.
const rq5 = fixture();
prs([], view(PR));
queue(rq5, parkedB({ draft_pr: 861, park: { question: 'awaiting the backfill', since: new Date().toISOString(), session_step: { step: 'run the backfill' } } }));
t('step-done re-points as requeue does', `${requeue('step-done').status} ${queued().branch} ${git(rq5, 'branch', '--show-current')}`, '0 task/K-1-pr task/K-1-pr');

// reject re-points too, and the note it leaves in the briefing names the branch the worker is put on.
const rq6 = fixture();
prs([], view(PR));
queue(rq6, parkedB({ result: { pr: 861 }, park: { question: 'spine awaiting approval: the specs', since: new Date().toISOString() } }));
const rr6 = spawnSync(process.execPath, [join(BIN, 'queue.mjs'), 'reject', 'K-1', 'cover the refund path'], { env, encoding: 'utf8' });
const brief6 = readFileSync(join(state, 'briefings', 'K-1.md'), 'utf8').split('acceptance specs back: cover the refund path').pop();
t('reject re-points as requeue does', `${rr6.status} ${queued().branch} ${git(rq6, 'branch', '--show-current')}`, '0 task/K-1-pr task/K-1-pr');
t('reject\'s note names the PR\'s branch, not the old one', `${brief6.includes('PR #861 on task/K-1-pr stays open')} ${brief6.includes('task/K-1-old')}`, 'true false');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
