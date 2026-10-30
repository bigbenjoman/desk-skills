// suite: batch (start, discard and archive a feature batch)
// batch.mjs against a scratch repo with a bare origin, a throwaway HOME and DESK_HOME: start refuses a
// second batch, a second live feature batch and a bad base; discard removes an unstarted batch and
// deletes its branch only when main has all of it; the archive check moves a done-with batch under
// batches/.done/ and hands open ticket PRs to the digest. PR states are injected, so no gh runs.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

// AC3: another epic's batch is refused while X-1 is live.
r = batch(['start', 'X-2', 'feat/x-2']);
t('AC3 another epic is refused while X-1 is live', r.code === 11 && r.out.includes('feature batch X-1 is live'), true);
t('AC3 no X-2 batch was made', existsSync(namedQ('X-2')), false);

t('a name that is no batch name is refused', batch(['start', '../x', 'feat/x-1']).code, 11);

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
t('AC10 setup: X-2 starts once X-1 is gone', batch(['start', 'X-2', 'feat/x-2']).code, 0);
r = batch(['discard', 'X-2']);
t('AC10 the batch is removed', r.code === 0 && !existsSync(namedQ('X-2')), true);
t('AC10 the branch is kept', onOrigin('feat/x-2'), true);
t('AC10 the output names the branch and why', r.out.includes('feat/x-2 kept on origin: it has 1 commit(s) that are not on main'), true);

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

// A pass or merge driver still holding the batch keeps it for the next tick.
writeQ('X-4', { epic: 'X-4', base: 'feat/x-4', promotion: { pr: 9 }, tickets: {} });
mkdirSync(namedS('X-4'), { recursive: true });
writeFileSync(join(namedS('X-4'), 'orchestrator.lock'), JSON.stringify({ pid: process.pid }));
a = res(archive('X-4', { 9: 'MERGED' }));
t('a live pass keeps the batch for the next tick', a.archived === false && existsSync(namedQ('X-4')) && (a.lines ?? []).join(' ').includes('a pass (pid'), true);

// The standing batch is never archived, even with a promotion that would archive a named one.
const standingQ = join(DESK_HOME, 'repos', SLUG, 'queue.json');
writeFileSync(standingQ, JSON.stringify({ version: 1, batch: 's1', promotion: { pr: 9 }, tickets: {} }));
t('the standing batch is never archived', res(run(`console.log(JSON.stringify(A.archiveCheck(B.listBatches()[0], { state: () => 'MERGED', mergedAt: () => '${MERGED_AT}' })))`)).archived === false && existsSync(standingQ), true);

if (fails) { console.log(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nall passed');
