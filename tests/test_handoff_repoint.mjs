// suite: handback re-points a ticket to its open PR's branch (queue.mjs handback, handoff.mjs repointToPr)
// covers: desk/bin/handoff.mjs desk/bin/queue.mjs
// Each case is a throwaway origin and worktree, a queue under a throwaway DESK_HOME, and a fake gh whose
// `pr list` answers with $T/prs.json. Nothing touches your real ~/.claude, state or GitHub.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'handoff-repoint-'));
process.on('exit', () => rmSync(T, { recursive: true, force: true }));
for (const k of Object.keys(process.env)) if (k.startsWith('DESK_') || k.startsWith('AUTOPILOT_')) delete process.env[k];

mkdirSync(join(T, 'bin'));
const PRS = join(T, 'prs.json');
writeFileSync(join(T, 'bin', 'gh'), `#!/bin/sh\n[ "$1 $2" = "pr list" ] || exit 1\ncat ${JSON.stringify(PRS)}\n`, { mode: 0o755 });
const prs = (list) => writeFileSync(PRS, JSON.stringify(list));
const state = join(T, 'state');
mkdirSync(state, { recursive: true });
const env = { ...process.env, HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_AUTOPILOT_STATE: state,
  DESK_QUEUE: join(T, 'queue.json'), DESK_GH_REPO: 'acme/widgets', DESK_LOCK_DIR: join(T, 'locks'), PATH: `${join(T, 'bin')}:${process.env.PATH}`,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });

const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (dir, msg) => git(dir, 'commit', '-q', '--allow-empty', '-m', msg);

// An origin holding main and the PR's branch `task/K-1-pr` one commit ahead of it, and a worktree cloned
// from it on the queued branch `task/K-1-old` at main, or on nothing of that name when `queued` is false.
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
    git(wt, 'checkout', '-q', '-b', 'task/K-1-old', 'origin/task/K-1-pr');
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

// AC2: the queued branch still exists, its worktree on it, with nothing the PR's head lacks; its PR is recorded.
const wt2 = fixture();
const old2 = git(wt2, 'rev-parse', 'HEAD');
prs([{ ...PR, number: 862 }, { ...PR, number: 900, title: 'K-1 a second PR', headRefName: 'task/K-1-other' }]);
queue(wt2, { draft_pr: 862 });
const r2 = handback();
t('AC2 a queued branch with no commits outside the PR is handed back', r2.status, 0);
t('AC2 it is re-pointed to the recorded PR\'s head, not another naming the ticket', `${queued().branch} ${git(wt2, 'branch', '--show-current')}`, 'task/K-1-pr task/K-1-pr');
t('AC2 the old ref is kept as a backup', git(wt2, 'rev-parse', 'refs/heads/desk-backup/task/K-1-old'), old2);
t('AC2 and the queued name is gone', spawnSync('git', ['-C', wt2, 'rev-parse', '--verify', '-q', 'refs/heads/task/K-1-old']).status !== 0, true);

// AC3: the queued branch has a commit that is not on the PR's head.
const wt3 = fixture({ extra: true });
const sha3 = git(wt3, 'rev-parse', '--short', 'HEAD');
prs([PR]);
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

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
