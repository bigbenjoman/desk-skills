// suite: base-red: reading a red base, its record, its lines and its repair ticket (base-red.mjs)
// layer: L2
// The pure parts of base-red.mjs, on canned commits and check runs: which check is red on the base's
// newest completed run, what stays unknown, the record's `since`, and the text the driver, the pass and
// the repair worker read.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scratch } from './scratch.mjs';

process.env.DESK_AUTOPILOT_STATE ??= scratch('base-red-');
const { baseState, lastMerges, liveBaseRed, nextRecord, holdLine, batchLine, repairTicket, repairTriage, WALK, STALE_MS, GREEN_FILE, readGreen } = await import('../desk/bin/base-red.mjs');
const E = await import('../desk/bin/desk-env.mjs');

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };
const sha = (c) => c.repeat(40);
// commits: { sha: { parent, runs } }, the tip first.
const reader = (commits, { tip = Object.keys(commits)[0], failRuns = null } = {}) => ({
  tip: () => (tip ? { sha: tip, parent: commits[tip]?.parent ?? null } : null),
  commit: (s) => (commits[s] ? { sha: s, parent: commits[s].parent ?? null } : null),
  runs: (s) => (s === failRuns ? null : commits[s]?.runs ?? []),
});
const run = (name, conclusion, url = null) => ({ name, status: 'completed', conclusion, url });

test('AC1 a required check whose newest completed run failed is red, naming its run', () => {
  const s = baseState({ required: ['tests'], branch: 'main', read: reader({ [sha('a')]: { parent: null, runs: [run('tests', 'failure', 'u/9')] } }) });
  assert.deepEqual(s, { state: 'red', sha: sha('a'), checks: [{ name: 'tests', sha: sha('a'), url: 'u/9' }] });
});

test('AC1 a run still going at the tip is passed over for the newest completed one below it', () => {
  const s = baseState({ required: ['tests'], branch: 'main', read: reader({
    [sha('b')]: { parent: sha('a'), runs: [{ name: 'tests', status: 'in_progress', conclusion: null }] },
    [sha('a')]: { parent: null, runs: [run('tests', 'failure')] },
  }) });
  assert.equal(s.state, 'red');
  assert.equal(s.sha, sha('b'));
  assert.equal(s.checks[0].sha, sha('a'));
});

test('AC6 a newest completed run that passed is green, whatever ran before it', () => {
  const s = baseState({ required: ['tests'], branch: 'main', read: reader({
    [sha('b')]: { parent: sha('a'), runs: [run('tests', 'success')] },
    [sha('a')]: { parent: null, runs: [run('tests', 'failure')] },
  }) });
  assert.deepEqual(s, { state: 'green' });
});

test('green read below a tip whose check is still going says so, so the green mark stays before its merge', () => {
  const s = baseState({ required: ['tests'], branch: 'main', read: reader({
    [sha('b')]: { parent: sha('a'), runs: [{ name: 'tests', status: 'in_progress', conclusion: null }] },
    [sha('a')]: { parent: null, runs: [run('tests', 'success')] },
  }) });
  assert.deepEqual(s, { state: 'green', tip_pending: true });
});

test('DS-969 AC1 a read that fails is unread, never green nor unknown', () => {
  assert.equal(baseState({ required: ['tests'], branch: 'main', read: reader({}, { tip: null }) }).state, 'unread');
  assert.equal(baseState({ required: ['tests'], branch: 'main', read: reader({ [sha('a')]: { runs: [] } }, { failRuns: sha('a') }) }).state, 'unread');
  assert.equal(baseState({ required: ['tests'], branch: 'main', read: reader({ [sha('a')]: { parent: sha('b'), runs: [] } }) }).state, 'unread');
});

test('AC7 a check with no completed run in the walk is unknown, and the walk stops at WALK commits', () => {
  const commits = {};
  for (let i = 0; i < WALK + 2; i++) commits[sha(String(i))] = { parent: sha(String(i + 1)), runs: i === WALK ? [run('tests', 'failure')] : [] };
  const s = baseState({ required: ['tests'], branch: 'main', read: reader(commits, { tip: sha('0') }) });
  assert.equal(s.state, 'unknown');
  assert.match(s.why, new RegExp(`no completed run of tests on the newest ${WALK} commits of main`));
});

test('a red check outranks another check left unknown; nothing required is none', () => {
  const s = baseState({ required: ['tests', 'lint'], branch: 'main', read: reader({ [sha('a')]: { parent: null, runs: [run('tests', 'failure')] } }) });
  assert.equal(s.state, 'red');
  assert.deepEqual(s.checks.map((c) => c.name), ['tests']);
  assert.deepEqual(baseState({ required: [], branch: 'main', read: reader({}) }), { state: 'none' });
});

test('a check found red stays red when a later read in the walk fails', () => {
  const tip = { [sha('b')]: { parent: sha('a'), runs: [run('tests', 'failure')] } };
  const runsFail = baseState({ required: ['tests', 'lint'], branch: 'main', read: reader({ ...tip, [sha('a')]: { parent: null, runs: [] } }, { tip: sha('b'), failRuns: sha('a') }) });
  assert.deepEqual([runsFail.state, runsFail.checks.map((c) => c.name)], ['red', ['tests']]);
  const commitFails = baseState({ required: ['tests', 'lint'], branch: 'main', read: reader(tip, { tip: sha('b') }) });
  assert.deepEqual([commitFails.state, commitFails.checks.map((c) => c.name)], ['red', ['tests']]);
});

test('the last merges are the repo\'s merged events, newest first', () => {
  const ev = [
    { repo: 'acme/w', pr: '1', event: 'merged', ticket: 'A-1', sha: 's1', at: 't1' },
    { repo: 'acme/other', pr: '9', event: 'merged' },
    { repo: 'Acme/W', pr: '2', event: 'claim' },
    { repo: 'acme/w', pr: '2', event: 'merged', sha: 's2', at: 't2' },
  ];
  assert.deepEqual(lastMerges(ev, 'acme/w'), [{ pr: 2, ticket: null, sha: 's2', at: 't2' }, { pr: 1, ticket: 'A-1', sha: 's1', at: 't1' }]);
});

test('the last merges are this driver\'s own: another batch\'s merges into another branch are not blamed', () => {
  const ev = [
    { repo: 'acme/w', pr: '1', event: 'merged', by: 'merge-driver acme__w' },
    { repo: 'acme/w', pr: '3', event: 'merged', by: 'merge-driver acme__w/batches/E-1' },
  ];
  assert.deepEqual(lastMerges(ev, 'acme/w', 'merge-driver acme__w').map((m) => m.pr), [1]);
});

test('a red spell names only the merges made since the base was last read green', () => {
  const ev = [5, 6, 7, 8, 9].map((pr, i) => ({ repo: 'acme/w', pr: String(pr), event: 'merged', at: `2026-11-18T1${i}:00:00.000Z` }));
  assert.deepEqual(lastMerges(ev, 'acme/w', null, 3, '2026-11-18T12:30:00.000Z').map((m) => m.pr), [9, 8]);
  assert.deepEqual(lastMerges(ev, 'acme/w', null, 3, null).map((m) => m.pr), [9, 8, 7]);
});

test('the green read is kept for its own branch only', () => {
  const dir = scratch('base-red-green-');
  writeFileSync(join(dir, GREEN_FILE), JSON.stringify({ branch: 'main', at: '2026-11-18T12:30:00.000Z' }));
  assert.deepEqual([readGreen(dir, 'main'), readGreen(dir, 'develop'), readGreen(join(dir, 'none'), 'main')], ['2026-11-18T12:30:00.000Z', null, null]);
});

test('AC6 a record no driver has rewritten for STALE_MS, or kept for another branch, is not current', () => {
  const dir = scratch('base-red-live-');
  const now = Date.parse('2026-11-21T12:00:00Z');
  const put = (r) => writeFileSync(join(dir, 'base-red.json'), JSON.stringify({ branch: 'main', checks: [{ name: 'tests' }], ...r }));
  put({ at: new Date(now - 60_000).toISOString() });
  assert.equal(liveBaseRed(dir, { branch: 'main', now })?.branch, 'main');
  assert.equal(liveBaseRed(dir, { branch: 'develop', now }), null);
  put({ at: new Date(now - STALE_MS - 1).toISOString() });
  assert.equal(liveBaseRed(dir, { branch: 'main', now }), null);
  put({ at: 'not a time' });
  assert.equal(liveBaseRed(dir, { now }), null);
});

test('the record keeps the red spell\'s first read as since, and is dropped once green', () => {
  const red = { state: 'red', sha: sha('a'), checks: [{ name: 'tests', sha: sha('a'), url: null }] };
  const first = nextRecord(null, red, { branch: 'main', merges: [], at: 'T1' });
  assert.equal(first.since, 'T1');
  assert.equal(first.repair_key, 'base-red-main');
  assert.equal(nextRecord(first, red, { branch: 'main', merges: [], at: 'T2' }).since, 'T1');
  assert.equal(nextRecord(first, { state: 'green' }, { branch: 'main', merges: [], at: 'T3' }), null);
});

test('DS-850 each red spell has its own repair key, kept for the spell', () => {
  const red = { state: 'red', sha: sha('a'), checks: [{ name: 'tests', sha: sha('a'), url: null }] };
  const one = nextRecord(null, red, { branch: 'main', merges: [], at: '2026-11-21T16:35:31.781Z' });
  assert.equal(one.repair_key, 'base-red-main-20261121163531');
  assert.equal(nextRecord(one, red, { branch: 'main', merges: [], at: '2026-11-21T17:00:00.000Z' }).repair_key, 'base-red-main-20261121163531');
  const two = nextRecord(null, red, { branch: 'main', merges: [], at: '2026-11-22T09:00:00.000Z' });
  assert.notEqual(two.repair_key, one.repair_key);
});

test('DS-850 a long branch\'s repair key stays a ticket id, apart from another long branch with the same start', () => {
  const long = `release/${'x'.repeat(80)}`;
  const k = E.baseRedKey(long, '2026-11-21T16:35:31Z');
  assert.ok(k.length <= 100 && E.SAFE_ID.test(k), k);
  assert.match(k, /-20261121163531$/);
  assert.notEqual(k, E.baseRedKey(`${long}y`, '2026-11-21T16:35:31Z'));
});

const rec = { branch: 'main', sha: sha('a'), checks: [{ name: 'tests', sha: sha('a'), url: 'https://x/runs/7' }], merges: [{ pr: 12, ticket: 'A-1', sha: sha('c'), at: 'T0' }], repair_key: 'base-red-main', since: 'T1' };

test('AC1 the driver\'s hold line names the check, its run and the last merges', () => {
  assert.equal(holdLine(rec), 'HOLDING on red main: required check "tests" (run https://x/runs/7) failed on its latest run there, so no PR merges into it but its repair base-red-main\'s; the last merges desk made: #12 (A-1)');
});

test('AC2 AC5 the batch line names the held PRs, and a repair no worker may make as nobody\'s step', () => {
  const off = batchLine(rec, { held: ['#5 (A-5)'], repair: { off: 'config §3 batch-base-push is "ask"' } });
  assert.match(off, /^main is red: "tests" \(run https:\/\/x\/runs\/7\) failed on its latest run there, since T1\./);
  assert.match(off, /The last merges desk made: #12 \(A-1\)\. It holds #5 \(A-5\)\./);
  assert.match(off, /The repair is a change on main that no ticket in the batch owns, so it is not one of your own steps: config §3 batch-base-push is "ask"$/);
  assert.match(batchLine(rec, { repair: { key: 'base-red-main', state: 'running' } }), /Repair ticket base-red-main is running/);
});

test('AC3 the repair ticket names the failing run and the last merges, and triages as a small lane A fix', () => {
  const t = repairTicket(rec);
  assert.match(t, /^# base-red-main\n/);
  assert.match(t, /- tests: failed at aaaaaaaaaaaa, run https:\/\/x\/runs\/7/);
  assert.match(t, /- PR #12 \(A-1\) at cccccccccccc, merged T0/);
  const r = repairTriage(rec);
  assert.deepEqual([r.ticket, r.lane, r.size, r.branch], ['base-red-main', 'A', 'S', 'fix/base-red-main']);
});

test('AC3 the repair key is a ticket id for the branch the driver merges into, an exported DESK_DEFAULT_BRANCH included', () => {
  const dir = scratch('base-red-kind-');
  const cfg = join(dir, 'config.md');
  writeFileSync(cfg, '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n| Default branch | `main` |\n\n## 4. Toolchain\n| Field | Value |\n|---|---|\n| Tracker | `jira` |\n| Ticket key pattern | `DS-[0-9]+` |\n| Other work id patterns | `none` |\n');
  const kind = (id, env = {}) => {
    const r = spawnSync('node', [join(import.meta.dirname, '..', 'desk', 'bin', 'desk-env.mjs'), 'ticket-kind', id], { env: { ...process.env, DESK_DEFAULT_BRANCH: '', DESK_CONFIG: cfg, DESK_REPO_OVERRIDE: 'acme/widgets', DESK_QUEUE: join(dir, 'no-queue.json'), ...env }, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : `exit ${r.status}`;
  };
  assert.deepEqual([kind('base-red-main'), kind('base-red-develop')], ['base-red', 'exit 2']);
  assert.deepEqual([kind('base-red-main-20261121163531'), kind('base-red-main-2026'), kind('base-red-develop-20261121163531'), kind('base-red-main-20261321163531')], ['base-red', 'exit 2', 'exit 2', 'exit 2']);
  const long = `release/${'x'.repeat(80)}`;
  assert.equal(kind(E.baseRedKey(long, '2026-11-21T16:35:31Z'), { DESK_DEFAULT_BRANCH: long }), 'base-red');
  assert.deepEqual([kind('base-red-develop', { DESK_DEFAULT_BRANCH: 'develop' }), kind('base-red-main', { DESK_DEFAULT_BRANCH: 'develop' })], ['base-red', 'exit 2']);
});

// DS-989: the walk through cachedRead, with every read the inner reader makes counted, and the cache
// saved and reopened between loops as the driver's processes do.
const { cachedRead, lsRemoteTip, originIs } = await import('../desk/bin/base-red.mjs');
const { openCache, CACHE_MS } = await import('../desk/bin/read-cache.mjs');
const counted = (commits, opts) => {
  const r = reader(commits, opts), calls = { tip: 0, commit: 0, runs: 0 };
  return { calls, read: { tip: (b) => (calls.tip++, r.tip(b)), commit: (s) => (calls.commit++, r.commit(s)), runs: (s) => (calls.runs++, r.runs(s)) } };
};
const loop = (path, read, now) => {
  const c = openCache(path, { now });
  const s = baseState({ required: ['tests'], branch: 'main', read: cachedRead(read, c, ['tests']) });
  c.save();
  return s;
};
const t0 = Date.parse('2026-11-22T10:00:00Z');
const below = { [sha('b')]: { parent: sha('a'), runs: [run('lint', 'success')] }, [sha('a')]: { parent: null, runs: [run('tests', 'failure', 'u/1')] } };

test('DS-989 AC1 a second loop on an unchanged tip whose runs all completed makes no commit or check-runs read', () => {
  const path = join(scratch('base-red-cache-'), 'base-runs.json');
  const { calls, read } = counted({ [sha('g')]: { parent: sha('b'), runs: [run('tests', 'failure', 'u/2'), run('lint', 'success')] }, ...below }, { tip: sha('g') });
  const first = loop(path, read, t0);
  assert.equal(first.state, 'red');
  assert.deepEqual(calls, { tip: 1, commit: 0, runs: 1 });
  const second = loop(path, read, t0 + 60_000);
  assert.deepEqual(second, first);
  assert.deepEqual(calls, { tip: 2, commit: 0, runs: 1 });
});

test('DS-989 AC1 AC2 a tip with no run of a required check yet is read again, as pending; the walk below it stays kept', () => {
  const path = join(scratch('base-red-cache-'), 'base-runs.json');
  const commits = { ...below };
  const { calls, read } = counted(commits, { tip: sha('b') });
  assert.equal(loop(path, read, t0).state, 'red');
  assert.deepEqual(calls, { tip: 1, commit: 1, runs: 2 });
  // The tip's own tests run appears late (a workflow_run workflow): the next loop reads it, not a's.
  commits[sha('b')] = { ...commits[sha('b')], runs: [run('lint', 'success'), run('tests', 'success')] };
  assert.equal(loop(path, read, t0 + 60_000).state, 'green');
  assert.deepEqual(calls, { tip: 2, commit: 1, runs: 3 });
  assert.equal(loop(path, read, t0 + 120_000).state, 'green');
  assert.deepEqual(calls, { tip: 3, commit: 1, runs: 3 });
});

test('DS-989 AC1 a tip with a run still going is read again, and only it: the commits below stay kept', () => {
  const path = join(scratch('base-red-cache-'), 'base-runs.json');
  const commits = { [sha('c')]: { parent: sha('b'), runs: [{ name: 'tests', status: 'in_progress', conclusion: null }] }, ...below };
  const { calls, read } = counted(commits, { tip: sha('c') });
  loop(path, read, t0);
  assert.deepEqual(calls, { tip: 1, commit: 2, runs: 3 });
  loop(path, read, t0 + 60_000);
  assert.deepEqual(calls, { tip: 2, commit: 2, runs: 4 });
});

test('DS-989 AC2 a commit with no runs yet is not kept, so its runs are read once they appear', () => {
  const path = join(scratch('base-red-cache-'), 'base-runs.json');
  const commits = { [sha('d')]: { parent: null, runs: [] } };
  const { calls, read } = counted(commits, { tip: sha('d') });
  assert.equal(loop(path, read, t0).state, 'unknown');
  commits[sha('d')].runs = [run('tests', 'success')];
  assert.equal(loop(path, read, t0 + 60_000).state, 'green');
  assert.equal(calls.runs, 2);
});

test('DS-989 AC4 a tip that moved is walked from the new tip, the commits below it still kept', () => {
  const path = join(scratch('base-red-cache-'), 'base-runs.json');
  const commits = { ...below };
  const { calls, read } = counted(commits, { tip: sha('b') });
  loop(path, read, t0);
  const moved = counted({ [sha('e')]: { parent: sha('b'), runs: [run('lint', 'success')] }, ...commits }, { tip: sha('e') });
  assert.equal(loop(path, moved.read, t0 + 60_000).state, 'red');
  // e and b are read (b, the old tip, was not kept while it had no tests run of its own); a stays kept.
  assert.deepEqual(moved.calls, { tip: 1, commit: 0, runs: 2 });
  assert.deepEqual(calls, { tip: 1, commit: 1, runs: 2 });
});

test('DS-989 AC4 a kept read older than 30 minutes is read afresh: a rerun that passed on the same tip shows', () => {
  const path = join(scratch('base-red-cache-'), 'base-runs.json');
  const commits = { [sha('f')]: { parent: null, runs: [run('tests', 'failure')] } };
  const { calls, read } = counted(commits, { tip: sha('f') });
  assert.equal(loop(path, read, t0).state, 'red');
  commits[sha('f')].runs = [run('tests', 'success')];
  assert.equal(loop(path, read, t0 + CACHE_MS).state, 'red');
  assert.equal(loop(path, read, t0 + CACHE_MS + 1).state, 'green');
  assert.equal(calls.runs, 2);
});

test('DS-989 a tip read with no parent (git ls-remote) takes it from a commit read, kept for the next loop', () => {
  const path = join(scratch('base-red-cache-'), 'base-runs.json');
  const r = reader(below, { tip: sha('b') }), calls = { commit: 0, runs: 0 };
  const read = { tip: () => ({ sha: sha('b') }), commit: (s) => (calls.commit++, r.commit(s)), runs: (s) => (calls.runs++, r.runs(s)) };
  assert.equal(loop(path, read, t0).state, 'red');
  assert.equal(loop(path, read, t0 + 60_000).state, 'red');
  // Both parents kept; only the tip's runs are read again, as it has no tests run of its own.
  assert.deepEqual(calls, { commit: 2, runs: 3 });
});

test('DS-989 lsRemoteTip takes the branch\'s own line, and null for none or a failed read', () => {
  const out = `${sha('1')}\trefs/heads/x/refs/heads/main\n${sha('2')}\trefs/heads/main\n`;
  assert.deepEqual(lsRemoteTip('main', () => out), { sha: sha('2') });
  assert.equal(lsRemoteTip('main', () => ''), null);
  assert.equal(lsRemoteTip('main', () => { throw new Error('no remote'); }), null);
});

test('DS-989 originIs matches an https, ssh or host-alias remote of the repo, any case, and nothing else', () => {
  const urls = ['https://github.com/Acme/Widgets.git\n', 'git@github.com:acme/widgets.git', 'https://github.com/acme/widgets/', 'ssh://git@github.com/acme/widgets', 'git@github-work:acme/widgets.git'];
  assert.deepEqual(urls.map((u) => originIs('acme/widgets', u)), [true, true, true, true, true]);
  assert.deepEqual(['/tmp/origin.git', 'git@github.com:acme/other.git', '', null].map((u) => originIs('acme/widgets', u)), [false, false, false, false]);
});

console.log(`base-red: ${pass} passed, 0 failed`);
