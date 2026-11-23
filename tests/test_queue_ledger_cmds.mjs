// suite: queue ledger commands (with the ledger lever on, every queue.mjs command that writes the queue appends what it changed, naming itself)
// layer: L2
// budget: 60 DS-893
// The writing commands test_queue_ledger.mjs does not run: each run as a process
// against its own fixture queue whose ledger sits beside it, with the lever on, a stub gh on PATH for
// those that read GitHub. Each case checks the command succeeded, the events it appended, and that
// every one names `queue.mjs <command>` as the writer.
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

const B = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('desk-qledger-cmds-');
for (const k of Object.keys(process.env)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete process.env[k];
const SLUG = 'acme__widgets';
const ON = join(T, 'config-on.md');
writeFileSync(ON, '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n| Default branch | `main` |\n\n'
  + '## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | `none` | `ledger` |\n\n'
  // No tracker, so a slug such as adopt's is a usable key.
  + '## 4. Project\n| Field | Value |\n|---|---|\n| Tracker | `none` |\n');
const HOME = join(T, 'home');
const STATE = join(T, 'state');
const REPO = join(T, 'repo');
mkdirSync(HOME);
mkdirSync(join(STATE, 'triage'), { recursive: true });
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
execFileSync('git', ['init', '-q', '-b', 'main', REPO]);
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');

// gh: `pr view <n>` prints $GH_DIR/pr-<n>.json (exit 1 when there is none), `pr ready` succeeds, and
// any other read (a `pr list`) finds nothing.
const BIN = join(T, 'bin');
mkdirSync(BIN);
writeFileSync(join(BIN, 'gh'), '#!/usr/bin/env bash\n'
  + 'if [ "$1 $2" = "pr view" ]; then f="$GH_DIR/pr-$3.json"; [ -f "$f" ] || { echo "no pull requests found for #$3" >&2; exit 1; }; cat "$f"; exit 0; fi\n'
  + 'if [ "$1 $2" = "pr ready" ]; then exit 0; fi\n'
  + 'echo "[]"\n');
chmodSync(join(BIN, 'gh'), 0o755);
const pr = (n, fields) => writeFileSync(join(T, `pr-${n}.json`), JSON.stringify({ number: n, isCrossRepository: false, ...fields }));

const ENV = { ...process.env, HOME, PATH: `${BIN}:${process.env.PATH}`, GH_DIR: T, DESK_CONFIG: ON, DESK_HOME: join(T, 'desk'),
  DESK_REPO_DIR: REPO, DESK_REPO_ROOT: REPO, DESK_AUTOPILOT_STATE: STATE, DESK_GITHUB_HANDLE: 'me', DESK_STOP_GRACE_MS: '400',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
Object.assign(process.env, { HOME, DESK_CONFIG: ON, DESK_HOME: ENV.DESK_HOME, DESK_REPO_DIR: REPO, DESK_REPO_ROOT: REPO });
const { read: readLog } = await import('../desk/bin/ticket-ledger.mjs');

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const write = (f, q) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(q, null, 2)}\n`); };
const tk = (key, more = {}) => ({ key, type: 'Task', lane: 'A', state: 'triaged', park: null, result: null, ...more });
const triage = (key, rec, dir = STATE) => write(join(dir, 'triage', `${key}.json`), { ticket: key, type: 'Task', lane: 'A', size: 'S', files_in_scope: [], blockers: [], ...rec });
const shape = (evs) => evs.map((e) => `${e.type} ${e.key}`).join(', ');
const by = (evs) => [...new Set(evs.map((e) => e.by.proc))].join(' ');
// The typed events alone: a command that also changes other fields appends a legacy_set beside them.
const typed = (evs) => shape(evs.filter((e) => e.type !== 'legacy_set'));

// queue.mjs <args> on queue `f`, after `q0` is written there: { r, f, evs }, evs being what it appended
// past the seeding a first write to the log makes.
let n = 0;
const run = (q0, args, { file, env = {} } = {}) => {
  const f = file ?? join(T, `q${++n}`, 'queue.json');
  if (q0) write(f, { version: 1, batch: 'b', ...q0 });
  const at = readLog(dirname(f)).events.length;
  const r = spawnSync(process.execPath, [join(B, 'queue.mjs'), ...args], { encoding: 'utf8', env: { ...ENV, DESK_QUEUE: f, ...env } });
  const evs = readLog(dirname(f)).events.slice(at).filter((e) => e.type !== 'seeded');
  if (r.status !== 0) console.log(`     queue.mjs ${args.join(' ')} exited ${r.status}: ${r.stdout}${r.stderr}`);
  return { r, f, evs, said: `${shape(evs)} / ${by(evs)}` };
};

// admit: a triaged ticket joins from its triage record.
{
  triage('AD-1', {});
  const { r, evs } = run({ tickets: {} }, ['admit', 'AD-1']);
  t('AC3 admit: admitted, then triaged', `${r.status} ${typed(evs)} / ${by(evs)}`, '0 admitted AD-1, triaged AD-1 / queue.mjs admit');
}

// adopt: an open PR with no ticket joins as a done ticket on it.
{
  pr(51, { state: 'OPEN', headRefName: 'fix/flaky', baseRefName: 'main', title: 'Fix the flaky spec', author: { login: 'me' } });
  const { r, said } = run({ tickets: {} }, ['adopt', 'fix-flaky', '51']);
  t('AC3 adopt: admitted, then its fields, the done state among them', `${r.status} ${said}`, '0 admitted fix-flaky, legacy_set fix-flaky / queue.mjs adopt');
}

// backfill-holds: a size park with no held_by gains the hold its triage record's blocker gives it.
{
  triage('BF-1', { size: 'L', blockers: [{ key: 'BF-2', category: 'new' }] });
  triage('BF-2', {});
  const { r, evs, said } = run({ tickets: { 'BF-1': tk('BF-1', { state: 'parked', park: { question: 'size L — split it before batching', since: 'x' } }), 'BF-2': tk('BF-2') } }, ['backfill-holds']);
  t('AC3 backfill-holds: the hold it adds, as a held event', `${r.status} ${said} ${evs[0]?.data.by} ${'held_by' in (evs[1]?.data.fields ?? {})}`, '0 held BF-1, legacy_set BF-1 / queue.mjs backfill-holds BF-2 false');
}

// clears-when: a park gains the condition that clears it.
{
  const { r, said } = run({ tickets: { 'CW-1': tk('CW-1', { state: 'parked', park: { question: 'merge the other PR first', since: 'x' } }) } }, ['clears-when', 'CW-1', 'pr', '12', 'merged']);
  t('AC3 clears-when: its park, with the condition', `${r.status} ${said}`, '0 legacy_set CW-1 / queue.mjs clears-when');
}

// stop: a running ticket's worker is ended and the ticket held.
{
  const wt = join(T, 'wt', 'ST-1');
  git('worktree', 'add', '-q', '-b', 'fix/ST-1', wt);
  const worker = spawn('bash', ['-c', 'sleep 300 & wait', 'x', 'claude', '-p', 'x', '--session-id', 's-ST-1'], { detached: true, stdio: 'ignore' });
  const { r, evs, said } = run({ tickets: { 'ST-1': tk('ST-1', { state: 'running', session_id: 's-ST-1', branch: 'fix/ST-1', worktree: wt, stage: '4/9' }) } }, ['stop', 'ST-1']);
  try { process.kill(-worker.pid, 'SIGKILL'); } catch { /* ended by stop */ }
  t('AC3 stop: parked, then the fields it cleared', `${r.status} ${said}`, '0 parked ST-1, legacy_set ST-1 / queue.mjs stop');
  t('DS-895 AC5 stop: the parked event is of kind stopped, and no legacy event holds the park',
    `${evs[0]?.data.kind} ${evs.some((e) => e.type === 'legacy_set' && 'park' in e.data.fields)}`, 'stopped false');
}

// handback: a lane C park whose session step the person did goes back to a worker at Stage 4b.
{
  const wt = join(T, 'wt', 'HB-1');
  git('worktree', 'add', '-q', '-b', 'fix/HB-1', wt);
  const { r, evs } = run({ tickets: { 'HB-1': tk('HB-1', { lane: 'C', state: 'parked', park: { question: 'lane C: needs a person to pick the copy', since: 'x' }, branch: 'fix/HB-1', worktree: wt }) } }, ['handback', 'HB-1', 'picked the copy']);
  t('AC3 handback: requeued, triaged, then lane B and Stage 4b', `${r.status} ${typed(evs)} / ${by(evs)} ${evs.at(-1)?.data.fields?.lane} ${evs.at(-1)?.data.fields?.handoff_stage}`, '0 requeued HB-1, triaged HB-1 / queue.mjs handback B 4b');
}

// finish: a parked ticket whose last step the orchestrator finished is recorded done on its PR.
{
  pr(61, { state: 'OPEN', isDraft: true, headRefName: 'fix/FN-1', baseRefName: 'main' });
  const { r, evs, said } = run({ tickets: { 'FN-1': tk('FN-1', { state: 'parked', park: { question: 'push the branch', since: 'x' }, branch: 'fix/FN-1' }) } }, ['finish', 'FN-1', '--pr', '61']);
  t('AC3 finish: done on its PR', `${r.status} ${said} ${evs[0]?.data.pr ?? evs[0]?.data.fields?.result?.pr}`, '0 finished FN-1, legacy_set FN-1 / queue.mjs finish 61');
}

// step-done: the person ran the step no worker can, and the ticket goes back to a worker.
{
  const { r, evs } = run({ tickets: { 'SD-1': tk('SD-1', { state: 'parked', park: { question: 'run the migration on staging', since: 'x', session_step: { step: 'run the migration on staging' } } }) } }, ['step-done', 'SD-1']);
  t('AC3 step-done: requeued, then triaged', `${r.status} ${typed(evs)} / ${by(evs)}`, '0 requeued SD-1, triaged SD-1 / queue.mjs step-done');
}

// follow-ran: the person ran a merged ticket's follow-on step.
{
  const { r, evs, said } = run({ tickets: { 'FR-1': tk('FR-1', { state: 'done', result: { pr: 7 }, merged_at: '2026-11-20T10:00:00.000Z', follow_on: [{ step: 'check staging' }] }) } },
    ['follow-ran', 'FR-1', JSON.stringify([{ step: 'check staging' }]), '2026-11-21T10:00:00.000Z']);
  t('AC3 follow-ran: the step settled', `${r.status} ${said} ${evs[0]?.data.fields?.follow_on_done}`, '0 legacy_set FR-1 / queue.mjs follow-ran 2026-11-21T10:00:00.000Z');
}

// approve: a feature spine whose specs passed is approved and done. This config grants neither the
// undraft nor the merge, so it exits 11 (for the person to do both) after its write.
{
  const { r, evs, said } = run({ tickets: { 'SP-1': tk('SP-1', { state: 'parked', park: { question: 'spine awaiting approval: its specs passed', since: 'x' }, spine_check: { ok: true }, result: { pr: 70 } }) } }, ['approve', 'SP-1']);
  t('AC3 approve: finished, then approved', `${r.status} ${said} ${evs.at(-1)?.data.fields?.approved}`, '11 finished SP-1, legacy_set SP-1 / queue.mjs approve true');
}

// reject: a spine's specs sent back: requeued for a new worker.
{
  const { r, evs } = run({ tickets: { 'RJ-1': tk('RJ-1', { state: 'parked', park: { question: 'spine specs incomplete: no spec for AC2', since: 'x' }, result: { pr: 71 }, branch: 'fix/RJ-1' }) } }, ['reject', 'RJ-1', 'add a spec for AC2']);
  t('AC3 reject: requeued, then triaged', `${r.status} ${typed(evs)} / ${by(evs)}`, '0 requeued RJ-1, triaged RJ-1 / queue.mjs reject');
}

// front and order change the spawn order, which is the queue's key order and no ticket's field: the
// queue is written, and the log, which records tickets, gains nothing.
{
  const { r, f, evs } = run({ tickets: { 'FT-1': tk('FT-1'), 'FT-2': tk('FT-2') } }, ['front', 'FT-2']);
  t('AC3 front: the queue is reordered and no ticket changed, so nothing is appended', `${r.status} ${Object.keys(read(f).tickets).join(' ')} ${read(f).version} ${evs.length}`, '0 FT-2 FT-1 2 0');
  const o = run(null, ['order', 'FT-1', 'FT-2'], { file: f });
  t('AC3 order: the same', `${o.r.status} ${Object.keys(read(f).tickets).join(' ')} ${read(f).version} ${o.evs.length}`, '0 FT-1 FT-2 3 0');
}

// merged: the merge driver records a ticket's merge time.
{
  const { r, evs, said } = run({ tickets: { 'MG-1': tk('MG-1', { state: 'done', result: { pr: 80 } }) } }, ['merged', 'MG-1', '2026-11-21T09:00:00.000Z']);
  t('AC3 merged: its merge time', `${r.status} ${said} ${evs[0]?.data.fields?.merged_at}`, '0 legacy_set MG-1 / queue.mjs merged 2026-11-21T09:00:00.000Z');
}

// transfer: a ticket moved from a named batch to the standing batch arrives there as moved, naming
// both batches, in the repo's one log.
{
  const DESK_HOME = join(T, 'xfer-desk');
  const repoDir = join(DESK_HOME, 'repos', SLUG);
  const named = join(repoDir, 'batches', 'E-2', 'queue.json');
  const namedState = join(HOME, '.desk-autopilot', SLUG, 'batches', 'E-2');
  write(join(repoDir, 'queue.json'), { version: 1, batch: 'standing-1', supervised: true, tickets: { 'S-1': tk('S-1', { state: 'running' }) } });
  write(named, { version: 1, batch: 'E-2', base: 'feat/e-2', supervised: true, tickets: { 'X-1': tk('X-1'), 'X-2': tk('X-2') } });
  triage('X-1', {}, namedState);
  // The repo's slug from the override, its batches under this DESK_HOME; the repo root stays, for the
  // worktrees folder transfer looks in.
  const env = { ...ENV, DESK_QUEUE: named, DESK_HOME, DESK_REPO_OVERRIDE: 'acme/widgets', DESK_MACHINE: join(T, 'none.md'), DESK_AUTOPILOT_STATE: namedState };
  delete env.DESK_REPO_DIR;
  const at = readLog(repoDir).events.length;
  const r = spawnSync(process.execPath, [join(B, 'queue.mjs'), 'transfer', 'X-1', 'standing'], { encoding: 'utf8', env });
  if (r.status !== 0) console.log(`     queue.mjs transfer exited ${r.status}: ${r.stdout}${r.stderr}`);
  const evs = readLog(repoDir).events.slice(at).filter((e) => e.type !== 'seeded');
  const moved = evs.find((e) => e.type === 'moved');
  t('AC3 transfer: moved, naming both batches', `${r.status} ${shape(evs)} / ${by(evs)} ${moved?.data.from}>${moved?.data.to}`, '0 moved X-1, legacy_set X-1 / queue.mjs transfer E-2>standing');
}

console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
