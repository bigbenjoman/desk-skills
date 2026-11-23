// suite: base-red: reading a red base, its record, its lines and its repair ticket (base-red.mjs)
// layer: L2
// The pure parts of base-red.mjs, on canned commits and check runs: which check is red on the base's
// newest completed run, what stays unknown, the record's `since`, and the text the driver, the pass and
// the repair worker read.
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scratch } from './scratch.mjs';

process.env.DESK_AUTOPILOT_STATE ??= scratch('base-red-');
const { baseState, lastMerges, liveBaseRed, nextRecord, holdLine, batchLine, repairTicket, repairTriage, baseRerun, setupFailed, SETUP_STEP, WALK, STALE_MS, GREEN_FILE, readGreen } = await import('../desk/bin/base-red.mjs');
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

// A required check that never runs on a push to the base (a PR-only review gate) is left out of the read.
test('a required PR-only gate with no run on main is left out: push checks green read green', () => {
  const s = baseState({ required: ['CI gate', 'Review gate'], branch: 'main', read: reader({ [sha('b')]: { parent: sha('a'), runs: [run('CI gate', 'success')] }, [sha('a')]: { parent: null, runs: [run('CI gate', 'success')] } }) });
  assert.deepEqual(s, { state: 'green', absent: ['Review gate'] });
});
test('a real push check failing beside the PR-only gate still reads red', () => {
  const s = baseState({ required: ['CI gate', 'Review gate'], branch: 'main', read: reader({ [sha('a')]: { parent: null, runs: [run('CI gate', 'failure', 'u/3')] } }) });
  assert.equal(s.state, 'red');
  assert.deepEqual(s.checks.map((c) => c.name), ['CI gate']);
});
test('a required check with a run still going and none completed is still waited for', () => {
  const s = baseState({ required: ['CI gate', 'e2e'], branch: 'main', read: reader({ [sha('a')]: { parent: null, runs: [run('CI gate', 'success'), { name: 'e2e', status: 'in_progress', conclusion: null }] } }) });
  assert.equal(s.state, 'unknown');
  assert.match(s.why, /no completed run of e2e/);
});
test('with no required check run on main at all, the read is unknown', () => {
  assert.equal(baseState({ required: ['Review gate'], branch: 'main', read: reader({ [sha('a')]: { parent: null, runs: [run('lint', 'success')] } }) }).state, 'unknown');
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
const { cachedRead, lsRemoteTip, originIs, RED_KEEP_MS } = await import('../desk/bin/base-red.mjs');
const { openCache, CACHE_MS } = await import('../desk/bin/read-cache.mjs');
const counted = (commits, opts) => {
  const r = reader(commits, opts), calls = { tip: 0, commit: 0, runs: 0 };
  return { calls, read: { tip: (b) => (calls.tip++, r.tip(b)), commit: (s) => (calls.commit++, r.commit(s)), runs: (s) => (calls.runs++, r.runs(s)) } };
};
const loop = (path, read, now) => {
  const c = openCache(path, { now });
  const s = baseState({ required: ['tests'], branch: 'main', read: cachedRead(read, c, ['tests'], { now }) });
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

test('DS-989 AC4 a kept red read older than five minutes is read afresh: a rerun that passed on the same tip shows', () => {
  const path = join(scratch('base-red-cache-'), 'base-runs.json');
  const commits = { [sha('f')]: { parent: null, runs: [run('tests', 'failure')] } };
  const { calls, read } = counted(commits, { tip: sha('f') });
  assert.equal(loop(path, read, t0).state, 'red');
  commits[sha('f')].runs = [run('tests', 'success')];
  assert.equal(loop(path, read, t0 + RED_KEEP_MS).state, 'red');
  assert.equal(loop(path, read, t0 + RED_KEEP_MS + 1).state, 'green');
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

const att = (id, conclusion, runId = 50) => ({ name: 'tests', status: 'completed', conclusion, url: `https://github.com/acme/widgets/actions/runs/${runId}/job/${id}` });
test('a green read is kept for the cache\'s whole lifetime, a red one only five minutes', () => {
  const path = join(scratch('base-red-cache-'), 'base-runs.json');
  const commits = { [sha('h')]: { parent: null, runs: [run('tests', 'success')] } };
  const { calls, read } = counted(commits, { tip: sha('h') });
  loop(path, read, t0); loop(path, read, t0 + RED_KEEP_MS + 60_000);
  assert.equal(calls.runs, 1);
});
test('a red list kept bare, as before red lists were dated, is read again', () => {
  const path = join(scratch('base-red-cache-'), 'base-runs.json');
  const commits = { [sha('k')]: { parent: null, runs: [run('tests', 'failure')] } };
  writeFileSync(path, JSON.stringify({ [`runs:${sha('k')}`]: { value: commits[sha('k')].runs, at: new Date(t0).toISOString() } }));
  commits[sha('k')].runs = [run('tests', 'success')];
  const { read } = counted(commits, { tip: sha('k') });
  assert.equal(loop(path, read, t0 + 60_000).state, 'green');
});

test('the driver\'s check reads a rerun that passed past five minutes as green, and lifts its record', () => {
  const dir = scratch('base-red-cli-'), bin = join(dir, 'bin'), state = join(dir, 'state'), cachePath = join(dir, 'base-runs.json'), runsFile = join(dir, 'runs.json');
  mkdirSync(bin); mkdirSync(state);
  const tip = sha('a');
  // What GitHub's check-runs read gives (filter=latest): the newest attempt of each job only.
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs'), a = process.argv.slice(2);
if (a[0] === 'api' && a[1] === 'repos/acme/widgets/commits/main') console.log(JSON.stringify({ sha: '${tip}', parent: null }));
else if (a[0] === 'api' && a[1].startsWith('repos/acme/widgets/commits/${tip}/check-runs')) process.stdout.write(fs.readFileSync('${runsFile}', 'utf8'));
else process.exit(1);
`, { mode: 0o755 });
  const cfg = join(dir, 'config.md');
  writeFileSync(cfg, '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n| Default branch | `main` |\n\n## 4. Checks\n| Field | Value |\n|---|---|\n| Required checks | `tests` |\n');
  const check = () => {
    const r = spawnSync('node', [join(import.meta.dirname, '..', 'desk', 'bin', 'base-red.mjs'), 'check', '--branch', 'main', '--repo', 'acme/widgets', '--state', state, '--cache', cachePath],
      { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DESK_CONFIG: cfg, DESK_REPO_OVERRIDE: 'acme/widgets' }, encoding: 'utf8' });
    return JSON.parse(r.stdout.trim()).state;
  };
  writeFileSync(runsFile, JSON.stringify([att(901, 'failure')]));
  assert.equal(check(), 'red');
  assert.equal(existsSync(join(state, 'base-red.json')), true);
  // The rerun's attempt 2 passes. Read again within five minutes, the kept red read still holds.
  writeFileSync(runsFile, JSON.stringify([att(902, 'success')]));
  assert.equal(check(), 'red');
  // Past five minutes it is read afresh: green, and the hold's record goes.
  const kept = JSON.parse(readFileSync(cachePath, 'utf8'));
  for (const v of Object.values(kept)) if (v?.value?.red != null) v.value.red -= RED_KEEP_MS + 1000;
  writeFileSync(cachePath, JSON.stringify(kept));
  assert.equal(check(), 'green');
  assert.equal(existsSync(join(state, 'base-red.json')), false);
});

// A red base the runner failed is re-run once before its repair is admitted.
const rr = (url) => ({ branch: 'main', checks: [{ name: 'Lint', sha: sha('a'), url }] });
const jobs = (...steps) => ({ jobs: [{ name: 'Install', steps: steps.map(([name, conclusion]) => ({ name, conclusion })) }] });
const installFailed = jobs(['Set up job', 'success'], ['Install browsers', 'failure']);
const URL78 = 'https://github.com/acme/widgets/actions/runs/78/job/5';
const never = () => { throw new Error('not read'); };

test('the setup steps are installs, cache restores, checkouts and the runner set-up, and not a build or test', () => {
  for (const n of ['Install dependencies', 'Install browsers', 'npm ci', 'Set up job', 'Run actions/setup-node@v4', 'Run actions/checkout@v4', 'Restore cache', 'Run actions/cache@v4', 'pnpm install']) assert.ok(SETUP_STEP.test(n), n);
  for (const n of ['Run tests', 'Build', 'Lint', 'Typecheck', 'Run playwright tests']) assert.ok(!SETUP_STEP.test(n), n);
});

test('a run\'s failed setup steps are read across its jobs, so a downstream check finding nothing is explained', () => {
  const view = { jobs: [installFailed.jobs[0], { name: 'Lint', steps: [{ name: 'Run tests', conclusion: 'failure' }] }] };
  assert.deepEqual(setupFailed(view), ['Install browsers']);
  assert.deepEqual(setupFailed(jobs(['Run tests', 'failure'])), []);
  assert.deepEqual(setupFailed(null), []);
});

test('a red base failed only at an install step is re-run once, and no repair is admitted', () => {
  const d = baseRerun(rr(URL78), { reran: [], view: () => installFailed, status: never, perm: 'yes' });
  assert.deepEqual(d.rerun, ['78']);
  assert.match(d.why, /failed at a setup step \("Install browsers"\)/);
});

test('a red base failed in a test or build step admits the repair as before', () => {
  assert.deepEqual(baseRerun(rr(URL78), { reran: [], view: () => jobs(['Install dependencies', 'success'], ['Run tests', 'failure']), status: never, perm: 'yes' }), { admit: true });
  // as does one whose run cannot be read, or whose check names no run
  assert.deepEqual(baseRerun(rr(URL78), { reran: [], view: () => null, status: never, perm: 'yes' }), { admit: true });
  assert.deepEqual(baseRerun(rr('https://ci.example.com/build/9'), { reran: [], view: never, status: never, perm: 'yes' }), { admit: true });
});

test('without the ci-rerun grant, an install failure admits the repair, saying why it was not re-run', () => {
  const d = baseRerun(rr(URL78), { reran: [], view: () => installFailed, status: never, perm: 'ask' });
  assert.equal(d.admit, true);
  assert.match(d.why, /config §3 ci-rerun is "ask"/);
});

test('once re-run, it waits while the rerun goes and while a passed rerun is read again, and admits once it fails again', () => {
  const at = (s, c) => () => ({ status: s, conclusion: c });
  assert.match(baseRerun(rr(URL78), { reran: ['78'], view: never, status: at('in_progress', ''), perm: 'yes' }).wait, /re-run once and is still going/);
  assert.match(baseRerun(rr(URL78), { reran: ['78'], view: never, status: at('completed', 'success'), perm: 'yes' }).wait, /re-run of run 78 passed/);
  const again = baseRerun(rr(URL78), { reran: ['78'], view: never, status: at('completed', 'failure'), perm: 'yes' });
  assert.equal(again.admit, true);
  assert.match(again.why, /failed again/);
  // a rerun whose run cannot be read is not waited on for ever
  assert.equal(baseRerun(rr(URL78), { reran: ['78'], view: never, status: () => null, perm: 'yes' }).admit, true);
});

test('a red base over two runs, one re-run already, re-runs only the other', () => {
  const two = { branch: 'main', checks: [{ name: 'Lint', sha: sha('a'), url: URL78 }, { name: 'e2e', sha: sha('a'), url: 'https://github.com/acme/widgets/actions/runs/79/job/6' }] };
  const done = (s, c) => () => ({ status: s, conclusion: c });
  const d = baseRerun(two, { reran: ['78'], view: () => installFailed, status: done('completed', 'success'), perm: 'yes' });
  assert.deepEqual(d.rerun, ['79']);
  // one already re-run that failed again admits the repair, and re-runs nothing
  assert.equal(baseRerun(two, { reran: ['78'], view: () => installFailed, status: done('completed', 'failure'), perm: 'yes' }).admit, true);
  // one already re-run still going waits, and re-runs nothing
  assert.ok(baseRerun(two, { reran: ['78'], view: () => installFailed, status: done('in_progress', ''), perm: 'yes' }).wait);
});

test('the batch line says no repair is admitted yet while a rerun comes first', () => {
  const l = batchLine({ branch: 'main', since: 't', checks: [{ name: 'Lint', sha: sha('a'), url: URL78 }], merges: [] }, { repair: { key: 'base-red-main', first: 'its failed run 78 failed at a setup step' } });
  assert.match(l, /No repair ticket is admitted yet: its failed run 78 failed at a setup step\. Repair ticket base-red-main is admitted if it fails again/);
});

// A red spell ends when the driver stops reading red, green or unknown: a required check that never runs
// on the base (a PR-only gate) leaves every read unknown, never green, and the next red is a spell of its own.
test('red, then green (one required check never runs on main), then red: two spells, and no record between', () => {
  const dir = scratch('base-red-spells-'), bin = join(dir, 'bin'), state = join(dir, 'state'), runsFile = join(dir, 'runs.json'), tipFile = join(dir, 'tip');
  mkdirSync(bin); mkdirSync(state);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs'), a = process.argv.slice(2), tip = fs.readFileSync('${tipFile}', 'utf8');
if (a[0] === 'api' && a[1] === 'repos/acme/widgets/commits/main') console.log(JSON.stringify({ sha: tip, parent: null }));
else if (a[0] === 'api' && a[1].startsWith('repos/acme/widgets/commits/' + tip + '/check-runs')) process.stdout.write(fs.readFileSync('${runsFile}', 'utf8'));
else process.exit(1);
`, { mode: 0o755 });
  const cfg = join(dir, 'config.md');
  writeFileSync(cfg, '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n| Default branch | `main` |\n\n## 4. Checks\n| Field | Value |\n|---|---|\n| Required checks | `CI gate` `Review gate` |\n');
  const check = (tip, runs) => {
    writeFileSync(tipFile, tip); writeFileSync(runsFile, JSON.stringify(runs));
    const r = spawnSync('node', [join(import.meta.dirname, '..', 'desk', 'bin', 'base-red.mjs'), 'check', '--branch', 'main', '--repo', 'acme/widgets', '--state', state],
      { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DESK_CONFIG: cfg, DESK_REPO_OVERRIDE: 'acme/widgets' }, encoding: 'utf8' });
    return JSON.parse(r.stdout.trim()).state;
  };
  const ci = (conclusion) => [{ name: 'CI gate', status: 'completed', conclusion, url: 'https://github.com/acme/widgets/actions/runs/7/job/1' }];
  assert.equal(check(sha('a'), ci('failure')), 'red');
  const first = JSON.parse(readFileSync(join(state, 'base-red.json'), 'utf8'));
  // The next push is green on CI gate; Review gate runs only on PRs, so it is left out and the base reads green.
  assert.equal(check(sha('b'), ci('success')), 'green');
  assert.equal(existsSync(join(state, 'base-red.json')), false);
  assert.equal(liveBaseRed(state, { branch: 'main' }), null);
  // A later flake is a new spell, its since its own.
  spawnSync('sleep', ['1.1']);
  assert.equal(check(sha('c'), ci('failure')), 'red');
  const second = JSON.parse(readFileSync(join(state, 'base-red.json'), 'utf8'));
  assert.notEqual(second.since, first.since);
  assert.notEqual(second.repair_key, first.repair_key);
});
test('a base that could not be read keeps the record as it was', () => {
  const dir = scratch('base-red-unread-'), bin = join(dir, 'bin'), state = join(dir, 'state');
  mkdirSync(bin); mkdirSync(state);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const cfg = join(dir, 'config.md');
  writeFileSync(cfg, '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n| Default branch | `main` |\n\n## 4. Checks\n| Field | Value |\n|---|---|\n| Required checks | `CI gate` |\n');
  const rec = { branch: 'main', sha: sha('a'), checks: [{ name: 'CI gate', sha: sha('a'), url: null }], merges: [], repair_key: 'base-red-main', since: 'T0', at: new Date().toISOString() };
  writeFileSync(join(state, 'base-red.json'), JSON.stringify(rec));
  const r = spawnSync('node', [join(import.meta.dirname, '..', 'desk', 'bin', 'base-red.mjs'), 'check', '--branch', 'main', '--repo', 'acme/widgets', '--state', state],
    { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DESK_CONFIG: cfg, DESK_REPO_OVERRIDE: 'acme/widgets' }, encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout.trim()).state, 'unread');
  assert.equal(JSON.parse(readFileSync(join(state, 'base-red.json'), 'utf8')).since, 'T0');
});

console.log(`base-red: ${pass} passed, 0 failed`);
