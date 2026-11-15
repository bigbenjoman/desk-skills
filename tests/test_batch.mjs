// suite: batch (start, discard and archive a feature batch)
// batch.mjs against a scratch repo with a bare origin, a throwaway HOME and DESK_HOME: start refuses a
// second batch, a second live feature batch and a bad base; discard removes an unstarted batch and
// deletes its branch only when main has all of it; the archive check moves a done-with batch under
// batches/.done/ and hands open ticket PRs to the digest. An epic planned, handed over and closed out
// with --batch beside a live standing batch never writes the standing queue. PR states are injected, so
// no gh runs.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-batch-'));
const HOME = join(T, 'home');
const DESK_HOME = join(T, 'deskhome');
const SLUG = 'acme__widgets';
const ORIGIN = join(T, 'origin.git');
const REPO = join(T, 'repo');
mkdirSync(HOME, { recursive: true });

const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', ORIGIN]);
execFileSync('git', ['init', '-q', '-b', 'main', REPO]);
for (const [k, v] of [['user.name', 'T'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false']]) g(REPO, 'config', k, v);
g(REPO, 'remote', 'add', 'origin', ORIGIN);
g(REPO, 'commit', '-q', '--allow-empty', '-m', 'root');
g(REPO, 'push', '-q', 'origin', 'main', 'main:feat/x-1', 'main:production');
g(REPO, 'switch', '-q', '-c', 'feat/x-2');
g(REPO, 'commit', '-q', '--allow-empty', '-m', 'work main lacks');
g(REPO, 'push', '-q', 'origin', 'feat/x-2');
g(REPO, 'switch', '-q', 'main');
const onOrigin = (b) => g(REPO, 'ls-remote', '--heads', 'origin', `refs/heads/${b}`) !== '';

const config = (push) => {
  const f = join(T, `config-${push}.md`);
  writeFileSync(f, `## 0. Repo\n\n| Field | Value |\n|---|---|\n| GitHub repo | \`acme/widgets\` |\n| Default branch | \`main\` |\n\n## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${REPO}\` |\n\n## 3. Permissions\n\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n| \`git-push\` | Push | \`ask\` | \`${push}\` |\n`);
  return f;
};
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DESK_|AUTOPILOT_)/.test(k)));
Object.assign(base, { HOME, DESK_HOME, DESK_CONFIG: config('yes'), DESK_REPO_OVERRIDE: 'acme/widgets', DESK_MACHINE: join(T, 'none.md'), DESK_SKILLS_DIR: join(T, 'no-skills') });

const batch = (args, env = {}) => {
  const r = spawnSync('node', [join(BIN, 'batch.mjs'), ...args], { cwd: REPO, encoding: 'utf8', env: { ...base, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
// Runs `code` with batch.mjs as A, batches.mjs as B and digest.mjs as D; -> { code, out, err }.
const run = (code) => {
  const src = `import * as A from '${join(BIN, 'batch.mjs')}'; import * as B from '${join(BIN, 'batches.mjs')}'; import * as D from '${join(BIN, 'digest.mjs')}'; ${code}`;
  const r = spawnSync('node', ['--input-type=module', '-e', src], { cwd: REPO, encoding: 'utf8', env: base });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const namedQ = (n) => join(DESK_HOME, 'repos', SLUG, 'batches', n, 'queue.json');
const namedS = (n) => join(HOME, '.desk-autopilot', SLUG, 'batches', n);
const doneQ = (n) => join(DESK_HOME, 'repos', SLUG, 'batches', '.done', n, 'queue.json');
const doneS = (n) => join(HOME, '.desk-autopilot', SLUG, 'batches', '.done', n);
const readQ = (n) => JSON.parse(readFileSync(namedQ(n), 'utf8'));
const writeQ = (n, q) => { mkdirSync(dirname(namedQ(n)), { recursive: true }); writeFileSync(namedQ(n), JSON.stringify({ version: 1, batch: n, ...q })); };
const listed = () => run("console.log(B.listBatches().map((b) => b.name ?? '-').join(' '))").out;

// AC4: a base that is main, a production branch, or not on origin; checked with no other batch live.
let r;
for (const [b, why] of [['main', 'main is the default branch'], ['production', 'never merges into a production branch'], ['feat/nope', 'feat/nope does not exist on origin'], ['bad..name', 'is not a valid branch name']]) {
  r = batch(['start', 'Z-1', b]);
  t(`AC4 ${b} is refused naming the reason`, r.code === 11 && r.out.includes(why), true);
}
t('AC4 no Z-1 batch was made', existsSync(dirname(namedQ('Z-1'))) || existsSync(namedS('Z-1')), false);

// AC1: a batch for X-1 on its branch, its epic and base set, not handed to the supervisor.
r = batch(['start', 'X-1', 'feat/x-1']);
t('AC1 start exits 0', r.code, 0);
const q1 = existsSync(namedQ('X-1')) ? readQ('X-1') : {};
t('AC1 the X-1 batch has its epic and base', `${q1.batch} ${q1.epic} ${q1.base}`, 'X-1 X-1 feat/x-1');
t('AC1 it is not handed to the supervisor', q1.supervised, undefined);
t('AC1 it is listed', listed(), '- X-1');
t('AC1 its state folder is made', existsSync(join(namedS('X-1'), 'batch-notes.md')), true);

// AC2: a second start for X-1 is refused naming it.
const before = readFileSync(namedQ('X-1'), 'utf8');
r = batch(['start', 'X-1', 'feat/x-1']);
t('AC2 a second start is refused', r.code, 11);
t('AC2 naming the existing batch', r.out.includes('batch X-1 already exists'), true);
t('AC2 the batch is unchanged', readFileSync(namedQ('X-1'), 'utf8'), before);

// AC3: another epic's batch on X-1's branch is refused; on its own branch it starts beside X-1.
r = batch(['start', 'X-2', 'feat/x-1']);
t('AC3 another epic on X-1\'s branch is refused naming X-1', r.code === 11 && r.out.includes('feature batch X-1 is live on feat/x-1'), true);
t('AC3 no X-2 batch was made', existsSync(namedQ('X-2')), false);
r = batch(['start', 'X-2', 'feat/x-2']);
t('DS-352 AC1 another epic on its own branch starts while X-1 is live', r.code, 0);
t('DS-352 AC1 both are listed', listed(), '- X-1 X-2');
t('DS-352 AC1 X-1 is unchanged', readFileSync(namedQ('X-1'), 'utf8'), before);
t('DS-352 AC1 setup: X-2 is discarded again', batch(['discard', 'X-2']).code, 0);

t('a name that is no batch name is refused', batch(['start', '../x', 'feat/x-1']).code, 11);

// DS-412 AC1: the in-session epic start (/desk-autopilot <EPIC>) refuses a base no copy of a §4 Required
// check's workflow runs on, before it makes anything. gh is a fake serving one ci.yml per ref from $WF.
const WF = join(T, 'wf'), FAKEBIN = join(T, 'fakebin');
mkdirSync(WF, { recursive: true }); mkdirSync(FAKEBIN, { recursive: true });
writeFileSync(join(FAKEBIN, 'gh'), `#!/bin/sh\ncase "$*" in\n  "api repos/"*"/contents/.github/workflows?ref="*) echo .github/workflows/ci.yml ;;\n  "api -H Accept: application/vnd.github.raw repos/"*"/contents/.github/workflows/ci.yml?ref="*) a="$*"; cat "${WF}/\${a##*ref=}.yml" ;;\n  *) exit 1 ;;\nesac\n`, { mode: 0o755 });
const ci = (ref, branches) => writeFileSync(join(WF, `${ref}.yml`), `name: CI\non:\n  pull_request:\n    branches: [${branches}]\njobs:\n  tests:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n`);
const reqCfg = join(T, 'config-required.md');
writeFileSync(reqCfg, `${readFileSync(base.DESK_CONFIG, 'utf8')}\n## 4. Toolchain\n\n| Field | Value |\n|---|---|\n| Required checks | \`tests\` |\n`);
const withReq = { DESK_CONFIG: reqCfg, PATH: `${FAKEBIN}:${process.env.PATH}` };
ci('main', 'main, production'); ci('feat%2Fx-2', 'main, production');
r = batch(['start', 'Y-1', 'feat/x-2'], withReq);
t('DS-412 AC1 batch.mjs start refuses a base no copy of the required check\'s workflow runs on, naming the check and its workflow file', r.code === 11 && r.out.includes('no batch started for Y-1: a required check does not run on PRs into feat/x-2, so no child PR could go green: "tests" never runs on PRs into feat/x-2 (workflow trigger: .github/workflows/ci.yml runs on pull requests only into main, production)'), true);
t('DS-412 AC1 before anything is made', existsSync(dirname(namedQ('Y-1'))) || existsSync(namedS('Y-1')), false);
ci('main', "main, 'feat/**'");
r = batch(['start', 'Y-1', 'feat/x-2'], withReq);
t('DS-412 a check only the default branch\'s copy runs is left to the base sync: the batch starts', r.code, 0);
t('DS-412 setup: Y-1 is discarded again', batch(['discard', 'Y-1']).code, 0);
ci('main', 'main'); ci('feat%2Fx-2', "main, 'feat/**'");
t('DS-412 AC3 negative control: a base the workflow triggers on starts', batch(['start', 'Y-1', 'feat/x-2'], withReq).code, 0);
t('DS-412 setup: Y-1 is discarded once more', batch(['discard', 'Y-1']).code, 0);

// AC9: a started ticket, or a batch handed to the supervisor, refuses the discard and removes nothing.
writeQ('X-1', { epic: 'X-1', base: 'feat/x-1', tickets: { 'X-5': { key: 'X-5', state: 'running' } } });
r = batch(['discard', 'X-1']);
t('AC9 a started ticket refuses the discard', r.code === 11 && r.out.includes('has started tickets (X-5)'), true);
writeQ('X-1', { epic: 'X-1', base: 'feat/x-1', tickets: { 'X-5': { key: 'X-5', state: 'parked', spawned_at: '2026-10-30T00:00:00Z' } } });
t('AC9 so does one a worker parked', batch(['discard', 'X-1']).code, 11);
writeQ('X-1', { epic: 'X-1', base: 'feat/x-1', supervised: true, tickets: { 'X-5': { key: 'X-5', state: 'triaged' } } });
r = batch(['discard', 'X-1']);
t('AC9 a batch handed to the supervisor refuses the discard', r.code === 11 && r.out.includes('handed to the supervisor'), true);
t('AC9 nothing was removed', existsSync(namedQ('X-1')) && existsSync(namedS('X-1')) && onOrigin('feat/x-1'), true);

// The branch is kept where config §3 git-push is not yes.
writeQ('X-1', { epic: 'X-1', base: 'feat/x-1', tickets: { 'X-5': { key: 'X-5', state: 'triaged' } } });
r = batch(['discard', 'X-1'], { DESK_CONFIG: config('ask') });
t('git-push ask: the batch is removed but the branch kept, saying why', r.code === 0 && !existsSync(namedQ('X-1')) && onOrigin('feat/x-1') && r.out.includes('git-push is "ask"'), true);

// AC8: an unstarted, unsupervised batch is removed, and its branch, with nothing main lacks, deleted.
t('AC8 setup: X-1 starts again', batch(['start', 'X-1', 'feat/x-1']).code, 0);
writeQ('X-1', { ...readQ('X-1'), tickets: { 'X-5': { key: 'X-5', state: 'triaged' } } });
r = batch(['discard', 'X-1']);
t('AC8 discard exits 0', r.code, 0);
t('AC8 its queue and state folders are removed', existsSync(dirname(namedQ('X-1'))) || existsSync(namedS('X-1')), false);
t('AC8 feat/x-1 is deleted from origin', onOrigin('feat/x-1'), false);
t('AC8 the output says so', r.out.includes('feat/x-1 deleted from origin'), true);
t('AC8 the batch is no longer listed', listed(), '-');
t('discarding a batch that does not exist is refused', batch(['discard', 'X-1']).code, 11);

// AC10: a branch with commits main lacks is kept, and the output names it and why.
t('AC10 setup: X-2 starts', batch(['start', 'X-2', 'feat/x-2']).code, 0);
r = batch(['discard', 'X-2']);
t('AC10 the batch is removed', r.code === 0 && !existsSync(namedQ('X-2')), true);
t('AC10 the branch is kept', onOrigin('feat/x-2'), true);
t('AC10 the output names the branch and why', r.out.includes('feat/x-2 kept on origin: it has 1 commit(s) that are not on main'), true);

// An epic's path as /desk-autopilot runs it, beside a live standing batch: every command names the
// epic's batch with --batch, and the standing queue is never written.
const standingQ = join(DESK_HOME, 'repos', SLUG, 'queue.json');
// plan-batch runs queue.mjs from DESK_HOME's bin, as an installed one does.
symlinkSync(BIN, join(DESK_HOME, 'bin'));
const cli =(script, args, env = {}) => {
  const x = spawnSync('node', [join(BIN, script), ...args], { cwd: REPO, encoding: 'utf8', env: { ...base, DESK_JIRA_NAME: 'Me', ...env } });
  return { code: x.status, out: `${x.stdout}${x.stderr}` };
};
mkdirSync(dirname(standingQ), { recursive: true });
writeFileSync(standingQ, JSON.stringify({ version: 1, batch: 'standing-1', supervised: true, approved: { workers: true }, tickets: { 'S-1': { key: 'S-1', state: 'running' } } }));
const standingBefore = readFileSync(standingQ, 'utf8');
// What triage.sh and expand-parent.mjs write for the epic's children, in its batch's state.
const triaged = (epic, keys) => {
  mkdirSync(join(namedS(epic), 'triage'), { recursive: true });
  for (const k of keys) writeFileSync(join(namedS(epic), 'triage', `${k}.json`), JSON.stringify({ ticket: k, type: 'Task', lane: 'A', lane_reason: 'r', summary: 's', branch: `feat/${k}`, files_in_scope: [`f/${k}`], unknowns: [], blockers: [] }));
  writeFileSync(join(namedS(epic), 'expansion.json'), JSON.stringify({ parent: epic, containers: {} }));
};
const plan = (epic, keys) => cli('plan-batch.mjs', ['--json', '--batch', epic, ...keys], { AUTOPILOT_WRITE_QUEUE: '1' });

// A declined plan: the batch is discarded, and its branch, holding nothing main lacks, goes from origin.
g(REPO, 'push', '-q', 'origin', 'main:feat/x-5');
t('DS-312 AC4 setup: X-5 starts beside the standing batch', batch(['start', 'X-5', 'feat/x-5', '--batch', 'X-5']).code, 0);
triaged('X-5', ['X-6', 'X-7']);
t('DS-312 AC4 setup: its plan is seeded', plan('X-5', ['X-6', 'X-7']).code, 0);
r = batch(['discard', 'X-5', '--batch', 'X-5']);
t('DS-312 AC4 a declined plan discards the batch', r.code === 0 && !existsSync(dirname(namedQ('X-5'))) && !existsSync(namedS('X-5')), true);
t('DS-312 AC4 and feat/x-5 is gone from origin', onOrigin('feat/x-5'), false);
t('DS-312 AC4 the standing batch is unchanged', readFileSync(standingQ, 'utf8'), standingBefore);

// AC1: expanded and planned with --batch, the children are seeded into the epic's queue only.
g(REPO, 'push', '-q', 'origin', 'main:feat/x-5');
t('DS-312 AC1 setup: X-5 starts again', batch(['start', 'X-5', 'feat/x-5', '--batch', 'X-5']).code, 0);
triaged('X-5', ['X-6', 'X-7']);
r = plan('X-5', ['X-6', 'X-7']);
t('DS-312 AC1 plan-batch --batch X-5 exits 0', r.code, 0);
t('DS-312 AC1 the children are seeded into X-5', Object.keys(readQ('X-5').tickets ?? {}).join(' '), 'X-6 X-7');
t('DS-312 AC1 X-5 keeps its epic and base', `${readQ('X-5').epic} ${readQ('X-5').base}`, 'X-5 feat/x-5');
t('DS-312 AC1 the standing queue is unchanged: its tickets, base and supervised flag', readFileSync(standingQ, 'utf8'), standingBefore);

// AC2: the Stage 3 approvals and the hand-over land on X-5. Standing intake decides from the standing
// queue alone (a batch on a base, or not handed over, admits nothing), and that queue is untouched.
r = cli('queue.mjs', ['--batch', 'X-5', 'set-batch', 'supervised=true', 'approved.workers=true', 'approved.merge=true']);
t('DS-312 AC2 the hand-over exits 0', r.code, 0);
t('DS-312 AC2 X-5 is supervised with its approvals', `${readQ('X-5').supervised} ${readQ('X-5').approved?.workers} ${readQ('X-5').approved?.merge}`, 'true true true');
t('DS-312 AC2 the standing queue is unchanged', readFileSync(standingQ, 'utf8'), standingBefore);
const sq = JSON.parse(readFileSync(standingQ, 'utf8'));
t('DS-312 AC2 so standing intake still finds it handed over and on no base', `${sq.supervised} ${sq.base ?? 'none'}`, 'true none');

// AC3: another epic on X-5's branch is refused, naming X-5, with nothing made.
r = batch(['start', 'X-8', 'feat/x-5', '--batch', 'X-8']);
t('DS-312 AC3 another epic on the live batch\'s branch is refused naming it', r.code === 11 && r.out.includes('feature batch X-5 is live on feat/x-5'), true);
t('DS-312 AC3 nothing is created for it', existsSync(dirname(namedQ('X-8'))) || existsSync(namedS('X-8')), false);
// On its own branch it gets its own slot beside the standing batch and X-5, which are left alone.
g(REPO, 'push', '-q', 'origin', 'main:feat/x-8');
const x5Live = readFileSync(namedQ('X-5'), 'utf8');
r = batch(['start', 'X-8', 'feat/x-8', '--batch', 'X-8']);
t('DS-352 AC1 a second epic starts while X-5 is live', r.code, 0);
t('DS-352 AC1 in its own slot, with its epic and base', `${readQ('X-8').epic} ${readQ('X-8').base}`, 'X-8 feat/x-8');
t('DS-352 AC1 three batches are listed', listed(), '- X-5 X-8');
t('DS-352 AC1 X-5 and the standing queue are unchanged', readFileSync(namedQ('X-5'), 'utf8') === x5Live && readFileSync(standingQ, 'utf8') === standingBefore, true);
rmSync(dirname(namedQ('X-8')), { recursive: true, force: true });
rmSync(namedS('X-8'), { recursive: true, force: true });
// A standing batch still on a feature branch holds that branch as a named batch does.
writeFileSync(standingQ, JSON.stringify({ ...JSON.parse(standingBefore), base: 'feat/x-8' }));
r = batch(['start', 'X-8', 'feat/x-8', '--batch', 'X-8']);
t('an epic on the standing batch\'s branch is refused naming it', r.code === 11 && r.out.includes('the standing batch is live on feat/x-8'), true);
t('and nothing is created for it', existsSync(dirname(namedQ('X-8'))) || existsSync(namedS('X-8')), false);
writeFileSync(standingQ, standingBefore);

// AC5: the close-out records the promotion PR it opened on X-5, where the archive check reads it.
r = cli('queue.mjs', ['--batch', 'X-5', 'set-batch', 'promotion.pr=42']);
t('DS-312 AC5 the promotion PR is recorded on X-5', r.code === 0 && readQ('X-5').promotion?.pr === 42, true);
t('DS-312 AC5 and not on the standing batch', readFileSync(standingQ, 'utf8'), standingBefore);

// AC7: plain tickets with no epic: Stage 0's init takes the standing slot as before, and X-5 is left alone.
const x5Before = readFileSync(namedQ('X-5'), 'utf8');
r = cli('queue.mjs', ['init', 'plain-1']);
t('DS-312 AC7 init with no --batch writes the standing queue', r.code === 0 && JSON.parse(readFileSync(standingQ, 'utf8')).batch === 'plain-1', true);
t('DS-312 AC7 and leaves the feature batch as it was', readFileSync(namedQ('X-5'), 'utf8'), x5Before);
// The archive checks below start with no named batch live.
rmSync(dirname(namedQ('X-5')), { recursive: true, force: true });
rmSync(namedS('X-5'), { recursive: true, force: true });
rmSync(standingQ, { force: true });

// The archive check, with PR states injected: {pr: state}. Every merged PR merged at MERGED_AT.
const MERGED_AT = '2026-10-30T12:00:00Z';
const archive = (name, states) => run(`const s = ${JSON.stringify(states)}; const b = B.listBatches().find((x) => x.name === '${name}');
  console.log(JSON.stringify(A.archiveCheck(b, { state: (n) => s[n] ?? 'OPEN', mergedAt: (n) => (s[n] === 'MERGED' ? '${MERGED_AT}' : null) })))`);
const res = (x) => { try { return JSON.parse(x.out); } catch { return { err: x.err }; } };
const handed = (n) => { try { return JSON.parse(readFileSync(join(namedS(n), 'handed.json'), 'utf8')); } catch { return {}; } };

// AC6: a running worker keeps the batch, unchanged.
writeQ('X-3', { epic: 'X-3', base: 'feat/x-3', promotion: { pr: 9 }, tickets: { 'X-6': { key: 'X-6', state: 'running' } } });
mkdirSync(namedS('X-3'), { recursive: true });
let qBefore = readFileSync(namedQ('X-3'), 'utf8');
let a = res(archive('X-3', { 9: 'CLOSED' }));
t('AC6 a running worker: not archived', a.archived, false);
t('AC6 the batch is unchanged', readFileSync(namedQ('X-3'), 'utf8') === qBefore && Object.keys(handed('X-3')).length, 0);

// A promotion PR still open, or none yet, keeps the batch too.
writeQ('X-3', { epic: 'X-3', base: 'feat/x-3', promotion: { pr: 9 }, tickets: { 'X-6': { key: 'X-6', state: 'done', result: { pr: 10 } } } });
t('an open promotion PR: not archived', res(archive('X-3', { 9: 'OPEN', 10: 'MERGED' })).archived, false);
writeQ('X-3', { epic: 'X-3', base: 'feat/x-3', tickets: { 'X-6': { key: 'X-6', state: 'done', result: { pr: 10 } } } });
t('no promotion PR: not archived', res(archive('X-3', { 10: 'MERGED' })).archived, false);
// A merged slice with children still to merge, or merged after it, is followed by the next one: the
// batch stays. Nothing the pass records is needed to tell, since an idle batch gets no pass.
writeQ('X-3', { epic: 'X-3', base: 'feat/x-3', promotion: { pr: 9 }, tickets: { 'X-6': { key: 'X-6', state: 'triaged' } } });
t('a merged promotion slice with children still to come: not archived', res(archive('X-3', { 9: 'MERGED' })).archived, false);
writeQ('X-3', { epic: 'X-3', base: 'feat/x-3', promotion: { pr: 9 }, tickets: { 'X-6': { key: 'X-6', state: 'done', result: { pr: 10 }, merged_at: '2026-10-30T13:00:00Z' } } });
t('a merged promotion slice with a child merged after it: not archived', res(archive('X-3', { 9: 'MERGED', 10: 'MERGED' })).archived, false);

// AC7: a closed promotion with a ticket PR still open: not archived, and the digest lists the PR.
writeQ('X-3', { epic: 'X-3', base: 'feat/x-3', promotion: { pr: 9 }, tickets: {
  'X-6': { key: 'X-6', state: 'done', result: { pr: 10 } },
  'X-7': { key: 'X-7', state: 'done', result: { pr: 11 } },
  'X-8': { key: 'X-8', state: 'done', result: { pr: 12 } },
} });
a = res(archive('X-3', { 9: 'CLOSED', 10: 'MERGED', 11: 'OPEN', 12: 'OPEN' }));
t('AC7 not archived', a.archived === false && existsSync(namedQ('X-3')), true);
t('AC7 each open PR is handed on', Object.values(handed('X-3')).map((e) => `${e.kind} ${e.ticket}`).sort().join(', '), 'archive X-7, archive X-8');
t('AC7 the report names them', (a.lines ?? []).join(' ').includes('waits on X-7 (PR #11), X-8 (PR #12)'), true);
const qs = run(`console.log(JSON.stringify(D.openQuestions({ slug: '${SLUG}', state: '${namedS('X-3')}', queue: '${namedQ('X-3')}' })))`);
const listedQs = (() => { try { return JSON.parse(qs.out); } catch { return []; } })();
t('AC7 the digest lists each open PR', listedQs.filter((x) => x.kind === 'archive').map((x) => x.ticket).join(' '), 'X-7 X-8');
t('AC7 naming the PR and the feature branch', listedQs.some((x) => x.text.includes('PR #11 into feat/x-3 is still open') && x.text.includes('promotion PR #9 is closed')), true);
a = res(archive('X-3', { 9: 'CLOSED', 10: 'MERGED', 11: 'OPEN', 12: 'OPEN' }));
t('AC7 a second check hands nothing new on', (a.lines ?? []).length, 0);
// A pass's prune leaves the archive's items alone.
t('AC7 a pass does not prune them', run(`const { pruneHanded } = await import('${join(BIN, 'decider.mjs')}'); pruneHanded('${namedS('X-3')}', []); console.log(Object.keys(JSON.parse((await import('node:fs')).readFileSync('${join(namedS('X-3'), 'handed.json')}', 'utf8'))).length)`).out, '2');
a = res(archive('X-3', { 9: 'CLOSED', 10: 'MERGED', 11: 'CLOSED', 12: 'OPEN' }));
t('AC7 a PR closed since is no longer listed', Object.values(handed('X-3')).map((e) => e.ticket).join(' '), 'X-8');

// AC5: promotion merged or closed, nothing running, no ticket PR open: moved under batches/.done/.
qBefore = readFileSync(namedQ('X-3'), 'utf8');
a = res(archive('X-3', { 9: 'CLOSED', 10: 'MERGED', 11: 'CLOSED', 12: 'MERGED' }));
t('AC5 archived', a.archived, true);
t('AC5 its queue is under batches/.done/', existsSync(doneQ('X-3')) && readFileSync(doneQ('X-3'), 'utf8') === qBefore && !existsSync(namedQ('X-3')), true);
t('AC5 so is its state', existsSync(doneS('X-3')) && !existsSync(namedS('X-3')), true);
t('AC5 the log line says why and where', (a.log ?? []).join(' ').includes('batch X-3 archived: its promotion PR #9 is closed'), true);
t('AC5 it is no longer listed', listed(), '-');
// A second batch of the same name archives beside the first, once its last promotion merges: every
// child merged before it, with no pass since to record it (the batch went idle first).
writeQ('X-3', { epic: 'X-3', base: 'feat/x-3', promotion: { pr: 9 }, tickets: { 'X-6': { key: 'X-6', state: 'done', result: { pr: 10 }, merged_at: '2026-10-30T11:00:00Z' } } });
a = res(archive('X-3', { 9: 'MERGED', 10: 'MERGED' }));
t('AC5 a second X-3 archives beside the first', a.archived === true && existsSync(doneQ('X-3')) && (a.log ?? []).join(' ').includes('.done/X-3.'), true);
t('AC5 a last promotion merged is logged as merged', (a.log ?? []).join(' ').includes('its promotion PR #9 is merged'), true);

// DS-523 AC3: a ticket left in a batch ready to archive is never archived with it. After a last
// promotion a pass recorded, one admitted since moves to the standing batch, and the archive line names it.
const standingLive = JSON.stringify({ version: 1, batch: 'standing-2', supervised: true, tickets: { 'S-1': { key: 'S-1', state: 'running' } } });
writeFileSync(standingQ, standingLive);
const lastRecorded = { pr: 9, merged: [{ pr: 9, slice: 1, merged_at: MERGED_AT }] };
writeQ('X-9', { epic: 'X-9', base: 'feat/x-9', promotion: lastRecorded, tickets: {
  'X-10': { key: 'X-10', state: 'done', result: { pr: 10 }, merged_at: '2026-10-30T11:00:00Z' },
  'X-11': { key: 'X-11', state: 'triaged' },
} });
mkdirSync(join(namedS('X-9'), 'triage'), { recursive: true });
writeFileSync(join(namedS('X-9'), 'triage', 'X-11.json'), JSON.stringify({ ticket: 'X-11', type: 'Task', lane: 'A', lane_reason: 'r', summary: 's', branch: 'fix/X-11', files_in_scope: ['f/X-11'], unknowns: [], blockers: [] }));
a = res(archive('X-9', { 9: 'MERGED', 10: 'MERGED' }));
t('DS-523 AC3 a ticket left after the last promotion: the batch is archived', a.archived, true);
t('DS-523 AC3 the ticket is in the standing batch', JSON.parse(readFileSync(standingQ, 'utf8')).tickets['X-11']?.state, 'triaged');
t('DS-523 AC3 and not in the archived queue', JSON.parse(readFileSync(doneQ('X-9'), 'utf8')).tickets['X-11'], undefined);
t('DS-523 AC3 the archive line names it', (a.log ?? []).join(' ').includes('moved X-11 to the standing batch'), true);
// DS-568: moved into a batch where its open blocker is parked as the person's step, a ticket merges after
// that step rather than losing the hold: nothing builds the step, so it is no build hold either.
const withStep = JSON.parse(readFileSync(standingQ, 'utf8'));
withStep.tickets['S-20'] = { key: 'S-20', state: 'parked', park: { question: "the person's step: labelled ben-step (config §4 Person-step labels), so no worker can do it" } };
writeFileSync(standingQ, JSON.stringify(withStep));
writeQ('X-30', { epic: 'X-30', base: 'feat/x-30', promotion: lastRecorded, tickets: {
  'X-31': { key: 'X-31', state: 'done', result: { pr: 10 }, merged_at: '2026-10-30T11:00:00Z' },
  'X-32': { key: 'X-32', state: 'triaged' },
  'X-33': { key: 'X-33', state: 'triaged' },
} });
mkdirSync(join(namedS('X-30'), 'triage'), { recursive: true });
writeFileSync(join(namedS('X-30'), 'triage', 'X-32.json'), JSON.stringify({ ticket: 'X-32', type: 'Task', lane: 'A', lane_reason: 'r', summary: 's', branch: 'fix/X-32', files_in_scope: ['f/X-32'], unknowns: [], blockers: [{ key: 'S-20', category: 'new' }] }));
writeFileSync(join(namedS('X-30'), 'triage', 'X-33.json'), JSON.stringify({ ticket: 'X-33', type: 'Task', lane: 'A', lane_reason: 'r', summary: 's', branch: 'fix/X-33', files_in_scope: ['f/X-33'], unknowns: [], blockers: [{ key: 'S-20', category: 'new' }],
  blocker_needs: { 'S-20': { needs: 'build', why: 'the build reads the images' } } }));
a = res(archive('X-30', { 9: 'MERGED', 10: 'MERGED' }));
const moved32 = JSON.parse(readFileSync(standingQ, 'utf8')).tickets['X-32'];
t('DS-568 a ticket moved to a batch where its blocker is the person\'s step merges after it, held by nothing', `${a.archived} ${moved32?.state} ${moved32?.held_by} ${moved32?.merge_after}`, 'true triaged null S-20');
const moved33 = JSON.parse(readFileSync(standingQ, 'utf8')).tickets['X-33'];
t('DS-687 one moved there whose triage calls that step needed to build is held behind it, not merged after it', `${moved33?.state} ${moved33?.held_by} ${moved33?.merge_after}`, 'parked S-20 undefined');
// With no record, a merged slice and a ticket still to come is not the last: nothing moves.
writeQ('X-12', { epic: 'X-12', base: 'feat/x-12', promotion: { pr: 9 }, tickets: { 'X-13': { key: 'X-13', state: 'queued' } } });
mkdirSync(namedS('X-12'), { recursive: true });
a = res(archive('X-12', { 9: 'MERGED' }));
t('DS-523 a merged slice no pass recorded as last: not archived, nothing moved', a.archived === false && readQ('X-12').tickets['X-13']?.state === 'queued', true);
// A refused move, or a closed promotion, hands the ticket to the digest and holds the archive.
const archiveMove = (name, states, why) => run(`const s = ${JSON.stringify(states)}; const b = B.listBatches().find((x) => x.name === '${name}');
  console.log(JSON.stringify(A.archiveCheck(b, { state: (n) => s[n] ?? 'OPEN', mergedAt: (n) => (s[n] === 'MERGED' ? '${MERGED_AT}' : null), move: () => ${JSON.stringify(why)} })))`);
writeQ('X-12', { epic: 'X-12', base: 'feat/x-12', promotion: lastRecorded, tickets: { 'X-13': { key: 'X-13', state: 'triaged' } } });
a = res(archiveMove('X-12', { 9: 'MERGED' }, 'the standing batch is not running'));
t('DS-523 AC3 a refused move: not archived', a.archived === false && existsSync(namedQ('X-12')), true);
t('DS-523 AC3 the ticket is handed to the digest with the reason', Object.values(handed('X-12')).some((e) => e.kind === 'archive' && e.ticket === 'X-13' && e.text.includes('the standing batch is not running')), true);
t('DS-523 AC3 the report names it', (a.lines ?? []).join(' ').includes('waits on X-13'), true);
t('DS-523 AC3 a handed ticket ready to run is parked, so no pass starts it', readQ('X-12').tickets['X-13']?.state === 'parked' && readQ('X-12').tickets['X-13']?.park?.question.includes('the standing batch is not running'), true);
a = res(archiveMove('X-12', { 9: 'MERGED' }, 'still refused'));
t('DS-523 AC3 a second check hands nothing new on', (a.lines ?? []).length === 0 && Object.keys(handed('X-12')).length === 1, true);
// A hold outside every batch is the person's to move with: that ticket is handed on, never moved.
writeQ('X-12', { epic: 'X-12', base: 'feat/x-12', promotion: lastRecorded, tickets: {
  'X-15': { key: 'X-15', state: 'parked', held_by: 'OUT-1', held_outside: 'OUT-1', park: { question: 'held by orchestrator: blocked by OUT-1', since: MERGED_AT } },
  'X-16': { key: 'X-16', state: 'parked', park: { question: 'which copy?', since: MERGED_AT, clears_when: 'pr 5 merged' } },
  'X-17': { key: 'X-17', state: 'parked', lane: 'A', park: { question: 'size XL: split it', since: MERGED_AT } },
} });
a = res(archiveMove('X-12', { 9: 'MERGED' }, null));
t('DS-523 AC3 a ticket held outside every batch is not moved', a.archived === false && readQ('X-12').tickets['X-15']?.held_outside === 'OUT-1', true);
t('DS-523 AC3 and is handed on naming its hold', Object.values(handed('X-12')).some((e) => e.ticket === 'X-15' && e.text.includes('held behind OUT-1 outside every batch')), true);
// A hold or a clears-when a pass would release with no person is replaced by the archive's own park.
const p15 = readQ('X-12').tickets['X-15']?.park ?? {};
t('DS-523 AC3 a held leftover is parked under the archive, no longer a hold', p15.question?.startsWith('left in batch X-12 after its promotion PR #9 merged') && p15.question.includes('it was parked: held by orchestrator'), true);
const p16 = readQ('X-12').tickets['X-16']?.park ?? {};
t('DS-523 AC3 a leftover parked for its own reason loses its clears-when, keeping its question', p16.clears_when === undefined && p16.question?.includes('it was parked: which copy?'), true);
a = res(archiveMove('X-12', { 9: 'MERGED' }, null));
t('DS-523 AC3 the archive\'s own park is not parked again', readQ('X-12').tickets['X-16']?.park?.question === p16.question, true);
// The archive's park hides an earlier one's start (a size park here), so the guards read its own prefix:
// no requeue, recorded condition, decider take or pass release starts a leftover in the finished batch.
const p17 = readQ('X-12').tickets['X-17']?.park ?? {};
t('DS-523 AC3 a size-parked leftover is parked under the archive', p17.question?.startsWith('left in batch X-12') && p17.question.includes('it was parked: size XL'), true);
for (const k of ['X-16', 'X-17']) {
  r = cli('queue.mjs', ['--batch', 'X-12', 'requeue', k]);
  t(`DS-523 AC3 requeue refuses ${k} left in the finished batch, naming the move`, r.code !== 0 && r.out.includes(`queue.mjs --batch X-12 transfer ${k} standing`) && readQ('X-12').tickets[k]?.state === 'parked', true);
}
r = cli('queue.mjs', ['--batch', 'X-12', 'clears-when', 'X-16', 'pr 5 merged']);
t('DS-523 AC3 clears-when refuses a leftover', r.code !== 0 && r.out.includes('transfer X-16 standing') && readQ('X-12').tickets['X-16']?.park?.clears_when === undefined, true);
r = run(`const S = await import('${join(BIN, 'batch-state.mjs')}'); const Dc = await import('${join(BIN, 'decider.mjs')}');
  const q = ${JSON.stringify(p17.question ?? '')};
  console.log(S.leftPark({ state: 'parked', park: { question: q } }), Dc.presort([{ kind: 'parked', lane: 'A', ticket: 'X-17', text: q }]).hand.length)`);
t('DS-523 AC3 leftPark reads it, and the decider hands it to the person', r.out, 'true 1');
writeQ('X-12', { epic: 'X-12', base: 'feat/x-12', promotion: { pr: 9 }, tickets: { 'X-14': { key: 'X-14', state: 'failed' } } });
a = res(archiveMove('X-12', { 9: 'CLOSED' }, null));
t('DS-523 AC3 a closed promotion: its left ticket is handed on, not moved', a.archived === false && !!readQ('X-12').tickets['X-14'] && Object.values(handed('X-12')).some((e) => e.ticket === 'X-14' && e.text.includes('was closed')), true);
t('DS-523 AC3 and the item of a ticket no longer left is dropped', Object.values(handed('X-12')).some((e) => e.ticket === 'X-13'), false);
writeQ('X-12', { epic: 'X-12', base: 'feat/x-12', promotion: { pr: 9 }, tickets: {} });
a = res(archive('X-12', { 9: 'CLOSED' }));
t('DS-523 AC3 once it is dropped the batch archives and its item goes', a.archived === true && existsSync(doneQ('X-12')), true);

// A pass or merge driver still holding the batch keeps it for the next tick.
writeQ('X-4', { epic: 'X-4', base: 'feat/x-4', promotion: { pr: 9 }, tickets: {} });
mkdirSync(namedS('X-4'), { recursive: true });
writeFileSync(join(namedS('X-4'), 'orchestrator.lock'), JSON.stringify({ pid: process.pid }));
a = res(archive('X-4', { 9: 'MERGED' }));
t('a live pass keeps the batch for the next tick', a.archived === false && existsSync(namedQ('X-4')) && (a.lines ?? []).join(' ').includes('a pass (pid'), true);
rmSync(join(namedS('X-4'), 'orchestrator.lock'));

// A live merge driver on a shut batch is stopped, and the batch archives once it has exited. `stop` is
// injected: it records the pid it was asked to stop in stops.log.
const stops = join(namedS('X-4'), 'stops.log');
const stopsMade = () => (existsSync(stops) ? readFileSync(stops, 'utf8').trim().split('\n').filter(Boolean) : []);
const archiveStop = (name, states) => run(`const s = ${JSON.stringify(states)}; const b = B.listBatches().find((x) => x.name === '${name}');
  const { appendFileSync } = await import('node:fs');
  console.log(JSON.stringify(A.archiveCheck(b, { state: (n) => s[n] ?? 'OPEN', mergedAt: (n) => (s[n] === 'MERGED' ? '${MERGED_AT}' : null), stop: (p) => appendFileSync('${stops}', p + '\\n') })))`);
const driverLock = join(namedS('X-4'), 'merge-driver.lock.d');
mkdirSync(driverLock, { recursive: true });
writeFileSync(join(driverLock, 'pid'), String(process.pid));
// AC2: an open promotion, or a ticket PR still open, leaves the driver running.
a = res(archiveStop('X-4', { 9: 'OPEN' }));
t('DS-525 AC2 an open promotion leaves the driver running', `${a.archived} ${a.stopped ?? false} ${stopsMade().length}`, 'false false 0');
writeQ('X-4', { epic: 'X-4', base: 'feat/x-4', promotion: { pr: 9 }, tickets: { 'X-9': { key: 'X-9', state: 'done', result: { pr: 13 } } } });
a = res(archiveStop('X-4', { 9: 'CLOSED', 13: 'OPEN' }));
t('DS-525 AC2 an open ticket PR leaves the driver running', `${a.archived} ${a.stopped ?? false} ${stopsMade().length}`, 'false false 0');
// AC1: shut, nothing running, no ticket PR open: the driver is told to stop, once.
writeQ('X-4', { epic: 'X-4', base: 'feat/x-4', promotion: { pr: 9 }, tickets: {} });
a = res(archiveStop('X-4', { 9: 'MERGED' }));
t('DS-525 AC1 a shut batch\'s live driver is told to stop', `${a.archived} ${a.stopped} ${stopsMade().join(',')}`, `false true ${process.pid}`);
t('DS-525 AC1 the report says so', (a.lines ?? []).join(' ').includes(`its merge driver (pid ${process.pid}) has nothing left to merge, so it was told to stop`), true);
a = res(archiveStop('X-4', { 9: 'MERGED' }));
t('DS-525 AC1 a driver still exiting is not told again', `${a.archived} ${a.stopped} ${stopsMade().length}`, 'false true 1');
t('DS-525 AC1 and the report says it has not exited yet', (a.lines ?? []).join(' ').includes('has not exited yet'), true);
// Once it has exited, the next tick archives the batch, saying the driver was stopped for it.
rmSync(driverLock, { recursive: true, force: true });
a = res(archiveStop('X-4', { 9: 'MERGED' }));
t('DS-525 AC1 the next tick archives it', a.archived === true && !existsSync(namedQ('X-4')), true);
t('DS-525 AC1 the archive line says the driver was stopped', (a.log ?? []).join(' ').includes(`its merge driver (pid ${process.pid}) was stopped for it`), true);

// A ticket moved to another batch takes its holds and its answers with it (queue.mjs transfer).
{
  const standingS = join(HOME, '.desk-autopilot', SLUG);
  writeFileSync(standingQ, JSON.stringify({ version: 1, batch: 'standing-3', supervised: true, tickets: {
    'S-1': { key: 'S-1', state: 'running' }, 'S-2': { key: 'S-2', state: 'parked', park: { question: 'which copy?' } },
    ...Object.fromEntries(['S-3', 'S-4'].map((k) => [k, { key: k, state: 'parked', park: { question: "the person's step: labelled ben-step (config §4 Person-step labels), so no worker can do it" } }])),
    'S-5': { key: 'S-5', state: 'parked', park: { question: "the person's step: labelled ben-input (config §4 Person-input labels), so no worker can do it" } },
    'S-6': { key: 'S-6', state: 'done', result: { pr: 42 } },
  } }));
  const held = (by) => ({ state: 'parked', held_by: by, park: { question: `held by orchestrator: blocked by ${by.split('|').join(', ')}`, since: MERGED_AT } });
  writeQ('Y-1', { base: 'feat/y-1', supervised: true, tickets: {
    'B-1': { key: 'B-1', state: 'triaged' },
    'T-1': { key: 'T-1', ...held('B-1|OUT-1'), held_outside: 'OUT-1' },
    'T-2': { key: 'T-2', state: 'triaged' },
    'T-3': { key: 'T-3', ...held('S-2') },
    'T-4': { key: 'T-4', ...held('B-1') },
    'T-5': { key: 'T-5', ...held('B-1') },
    'T-6': { key: 'T-6', ...held('B-1'), collides_with: 'B-1' },
    'M-1': { key: 'M-1', state: 'done', merged_at: MERGED_AT, result: { pr: 7 } },
    'B-2': { key: 'B-2', state: 'triaged' },
    'T-7': { key: 'T-7', ...held('GONE-1') },
    'T-8': { key: 'T-8', ...held('M-1|B-1') },
    'T-9': { key: 'T-9', ...held('B-2') },
    'T-10': { key: 'T-10', state: 'triaged', held_by: null, park: null, held_outside: 'OUT-1' },
    'T-11': { key: 'T-11', ...held('S-3') },
    'T-12': { key: 'T-12', ...held('S-4') },
    'T-13': { key: 'T-13', ...held('S-4') },
    'T-14': { key: 'T-14', ...held('S-5') },
    'T-15': { key: 'T-15', state: 'triaged', merge_after: 'S-6' },
    'T-16': { key: 'T-16', state: 'triaged', merge_after: 'S-6' },
  } });
  const yState = (...p) => join(namedS('Y-1'), ...p);
  mkdirSync(yState('triage'), { recursive: true });
  const onB1 = [{ key: 'B-1', category: 'indeterminate' }];
  const recs = { 'T-1': { blockers: onB1 }, 'T-4': { blockers: onB1, size: 'XL' }, 'T-8': { blockers: onB1 }, 'T-9': { blockers: [{ key: 'B-2', category: 'done' }] },
    'T-12': { blockers: [{ key: 'S-4', category: 'done' }] }, 'T-13': { blockers: [{ key: 'S-4', category: 'indeterminate' }] },
    'T-14': { blockers: [{ key: 'S-5', category: 'indeterminate' }] },
    'T-15': { blockers: [{ key: 'S-6', category: 'done' }], blocker_needs: { 'S-6': { needs: 'merge', why: 'the rollout flag must land first' } } },
    'T-16': { blockers: [{ key: 'S-6', category: 'done' }], blocker_needs: { 'S-6': { needs: 'none', why: 'independent' } } } };
  for (const k of ['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6', 'T-7', 'T-8', 'T-9', 'T-10', 'T-11', 'T-12', 'T-13', 'T-14', 'T-15', 'T-16']) {
    writeFileSync(yState('triage', `${k}.json`), JSON.stringify({ ticket: k, type: 'Bug', lane: 'A', lane_reason: 'r', summary: 's', branch: `fix/${k}`, files_in_scope: [`f/${k}`], unknowns: [], blockers: [], ...recs[k] }));
  }
  const answer = (text) => `\n## Answer from the user (2026-11-14T10:00:00Z)\n\n${text}\n`;
  mkdirSync(yState('briefings'), { recursive: true });
  mkdirSync(yState('answers'), { recursive: true });
  writeFileSync(yState('briefings', 'T-1.md'), `# Briefing for T-1\n${answer('use the blue one')}`);
  writeFileSync(yState('answers', 'T-1.txt'), 'use the blue one\n');
  writeFileSync(yState('briefings', 'T-3.md'), `# Briefing for T-3\n${answer('ship it on Friday')}`);
  writeFileSync(yState('briefings', 'T-4.md'), `# Briefing for T-4\n${answer('split it')}`);
  mkdirSync(join(standingS, 'briefings'), { recursive: true });
  writeFileSync(join(standingS, 'briefings', 'T-3.md'), `# Briefing for T-3\n${answer('the copy is final')}`);
  const moveTo = (k) => cli('queue.mjs', ['--batch', 'Y-1', 'transfer', k, 'standing']);
  const sq = () => JSON.parse(readFileSync(standingQ, 'utf8')).tickets;

  r = moveTo('T-1');
  const t1 = sq()['T-1'] ?? {};
  t('DS-665 AC1 a ticket held behind one left in its batch is moved', r.code === 0 && !('T-1' in readQ('Y-1').tickets), true);
  t('DS-665 AC1 it arrives held, its blocker left behind recorded as outside', `${t1.state} ${t1.held_by} ${t1.held_outside} ${String(t1.park?.question).startsWith('held by orchestrator: blocked by B-1, OUT-1')}`, 'parked B-1|OUT-1 B-1|OUT-1 true');
  t('DS-665 AC1 the output says it is held', r.out.includes('held behind B-1, OUT-1'), true);
  t('DS-665 AC2 its blocker in no batch is still held outside', String(t1.held_outside).split('|').includes('OUT-1'), true);
  t('DS-665 AC3 its briefing goes with it, answers and all', readFileSync(join(standingS, 'briefings', 'T-1.md'), 'utf8'), readFileSync(yState('briefings', 'T-1.md'), 'utf8'));
  t('DS-665 AC3 an answer no worker has read yet goes with it', readFileSync(join(standingS, 'answers', 'T-1.txt'), 'utf8'), 'use the blue one\n');

  r = moveTo('T-2');
  const t2 = sq()['T-2'] ?? {};
  t('DS-665 AC4 a ticket with no holds and no briefing arrives as before', `${r.code} ${t2.state} ${t2.held_by} ${'held_outside' in t2} ${existsSync(join(standingS, 'briefings', 'T-2.md'))}`, '0 triaged null false false');

  r = moveTo('T-3');
  const t3 = sq()['T-3'] ?? {};
  t('DS-665 a hold on a ticket already in the destination stays an ordinary hold there', `${r.code} ${t3.state} ${t3.held_by} ${'held_outside' in t3}`, '0 parked S-2 false');
  const b3 = readFileSync(join(standingS, 'briefings', 'T-3.md'), 'utf8');
  t('DS-665 AC3 a briefing already in the destination keeps its answers and gains the moved ones', b3.includes('the copy is final') && b3.includes('ship it on Friday'), true);

  const files = () => [standingQ, namedQ('Y-1'), join(standingS, 'triage', 'T-4.json'), join(standingS, 'briefings', 'T-4.md'), yState('triage', 'T-4.json'), yState('briefings', 'T-4.md')]
    .map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : '(none)')).join('\n--\n');
  const before = files();
  r = moveTo('T-4');
  t('DS-665 AC5 a move the destination refuses fails, naming why', r.code !== 0 && r.out.includes('cannot be held as well'), true);
  t('DS-665 AC5 and neither batch\'s queue, triage record or briefing changed', files(), before);

  // A hold the person set, on a ticket that is no Jira blocker, would be lifted by the next pass there.
  const before5 = `${readFileSync(standingQ, 'utf8')}\n${readFileSync(namedQ('Y-1'), 'utf8')}`;
  r = moveTo('T-5');
  t('DS-665 a hold that is no Jira blocker refuses the move, naming it', r.code !== 0 && r.out.includes('T-5 is held behind B-1, which is not a blocker of it in Jira'), true);
  t('DS-665 and nothing moved', `${readFileSync(standingQ, 'utf8')}\n${readFileSync(namedQ('Y-1'), 'utf8')}`, before5);
  r = moveTo('T-6');
  const t6 = sq()['T-6'] ?? {};
  t('DS-665 a hold for this batch\'s files stays behind, and the output says so', `${r.code} ${t6.state} ${t6.held_by} ${r.out.includes('its hold on B-1, for this batch\'s files, spine or epic, stays here')}`, '0 triaged null true');

  // A hold on a ticket no longer in any batch (dropped since) is the person's to settle: it refuses too.
  const before7 = `${readFileSync(standingQ, 'utf8')}\n${readFileSync(namedQ('Y-1'), 'utf8')}`;
  r = moveTo('T-7');
  t('DS-665 a hold on a ticket in no batch and no blocker refuses the move, naming it', r.code !== 0 && r.out.includes('T-7 is held behind GONE-1, which is not a blocker of it in Jira'), true);
  t('DS-665 and nothing moved for it', `${readFileSync(standingQ, 'utf8')}\n${readFileSync(namedQ('Y-1'), 'utf8')}`, before7);
  // A hold on a ticket here already merged is satisfied: it neither refuses the move nor goes with it.
  r = moveTo('T-8');
  const t8 = sq()['T-8'] ?? {};
  t('DS-665 a hold on a merged ticket here is dropped, its open blocker still held outside', `${r.code} ${t8.state} ${t8.held_by} ${t8.held_outside}`, '0 parked B-1 B-1');
  // A blocker Jira reads Done whose code has not landed still holds it, outside, until it is on the base.
  r = moveTo('T-9');
  const t9 = sq()['T-9'] ?? {};
  t('DS-665 a Done blocker left in this batch is held outside, not refused', `${r.code} ${t9.state} ${t9.held_by} ${t9.held_outside}`, '0 parked B-2 B-2');
  // A release clears held_by and leaves held_outside: the hold the person lifted stays lifted.
  r = moveTo('T-10');
  const t10 = sq()['T-10'] ?? {};
  t('DS-665 a ticket the person released arrives unheld, its old outside hold not reinstated', `${r.code} ${t10.state} ${t10.held_by} ${'held_outside' in t10}`, '0 triaged null false');
  // DS-568: a hold on a person's step in the destination. As an open Jira blocker it merges after the
  // step. As no blocker it stays a hold: a pass lifts a merge_after step the blockers do not list. As a
  // Done blocker it holds nothing.
  const step = (k) => { const r2 = moveTo(k); const s = sq()[k] ?? {}; return `${r2.code} ${s.state} ${s.held_by} ${s.merge_after}`; };
  t('DS-568 a hold on a person\'s step there that is an open blocker merges after it', step('T-13'), '0 triaged null S-4');
  t('DS-568 a hold on a person\'s step there that is no blocker stays a hold', step('T-11'), '0 parked S-3 undefined');
  t('DS-568 a hold on a person\'s step there that is a Done blocker holds nothing', step('T-12'), '0 triaged null undefined');
  // A step parked on a Person-input label makes what the build reads: an open blocker there stays a hold.
  t('DS-682 a hold on an input step there that is an open blocker stays a hold, not a merge gate', step('T-14'), '0 parked S-5 undefined');
  // A merge gate triage set on another ticket's code: Done in Jira with its PR not yet merged there, it
  // stays a gate, which that batch's pass lifts once the code lands. With no merge call it goes.
  t('DS-687 a triage merge gate on a ticket there that Jira reads Done stays a merge gate', step('T-15'), '0 triaged null S-6');
  t('DS-687 a merge_after on a ticket there that triage found not needed goes', step('T-16'), '0 triaged null undefined');
}

// The standing batch is never archived, even with a promotion that would archive a named one.
writeFileSync(standingQ, JSON.stringify({ version: 1, batch: 's1', promotion: { pr: 9 }, tickets: {} }));
t('the standing batch is never archived', res(run(`console.log(JSON.stringify(A.archiveCheck(B.listBatches()[0], { state: () => 'MERGED', mergedAt: () => '${MERGED_AT}' })))`)).archived === false && existsSync(standingQ), true);

if (fails) { console.log(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nall passed');
