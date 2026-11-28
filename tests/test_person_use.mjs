// suite: person in use (the rows and their defaults, what processes other than desk's hold, the mode switching on and off, placement at start)
// layer: L1
// covers: desk/bin/person-use.mjs desk/bin/machine.mjs desk/bin/pass/shared.mjs
// person-use.mjs on fixture `ps` output and a fixed clock; the machine profile's row checks; the
// placement rule by itself (desk-q's line and place are in test_desk_q_eta.mjs, the pass's in
// test_pass_spawns.sh).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { personUseRows, parsePs, othersHold, overThreshold, nextMode, readProcs, modeLine } from '../desk/bin/person-use.mjs';
import { benchSettingError } from '../desk/bin/machine.mjs';
import { placeAtStart, cloudAble, startsInCloud, fromCloudPr } from '../desk/bin/pass/shared.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const S = scratch('person-use-');

// AC3 the rows: unset, each defaults from the profile's memory and cores; set, each is read; set wrong,
// its default, said.
{
  const get = (rows) => (k) => rows[k] ?? null;
  const d = personUseRows(get({ 'memory-gb': '64', 'cpu-cores': '16' }));
  t('issue-1587 AC3 unset rows default from the profile (64 GB, 16 cores)', [d.on, d.baselineGb, d.baselineCpu, d.overGb, d.overCpu, d.floor, d.calmMin], [true, 9.6, 0.8, 6.4, 4, 1, 10]);
  t('issue-1587 AC3 with no hardware rows, the fallbacks', (({ baselineGb, baselineCpu, overGb, overCpu }) => [baselineGb, baselineCpu, overGb, overCpu])(personUseRows(get({}))), [2, 0.5, 2, 1]);
  const set = personUseRows(get({ 'memory-gb': '64', 'cpu-cores': '16', 'person-baseline-gb': '12', 'person-use-gb': '3', 'person-use-floor': '2', 'person-use-calm-min': '5' }));
  t('issue-1587 AC3 set rows are read', [set.baselineGb, set.overGb, set.floor, set.calmMin], [12, 3, 2, 5]);
  const bad = personUseRows(get({ 'memory-gb': '64', 'person-use-floor': '1.5', 'person-use': 'maybe' }));
  t('issue-1587 AC3 a row set wrong reads as its default, and says so', [bad.floor, bad.on, bad.problems], [1, true, ['`person-use-floor` is "1.5": read as 1', '`person-use` is "maybe": want on or off; read as on']]);
  t('issue-1587 AC3 off turns it off', personUseRows(get({ 'person-use': 'off' })).on, false);
  t('issue-1587 AC3 desk-env machine set checks each row', [benchSettingError('person-use-gb', '4'), benchSettingError('person-use-floor', '1'), benchSettingError('person-use', 'on'), benchSettingError('person-use-gb', '0')],
    [null, null, null, '`person-use-gb` is "0": want a number of GB over 0']);
}

// AC3 what processes other than desk's hold: a worker's tree (its dev server and test run under it), the
// pass asking and its parents, and anything naming desk's bin or a worktree are desk's.
const PS = [
  '    1     0   10000  0.0 /sbin/init',
  '  100     1 2097152 40.0 /Applications/IDE.app/ide',
  '  101     1 1048576 60.0 /usr/bin/browser --tab',
  '  200     1   20000  0.0 bash -c "$@"; rc=$? desk-worker claude -p go',
  '  201   200 4194304 90.0 claude -p go --settings /h/.desk-autopilot/workers/K-1.json',
  '  202   201 3145728 80.0 node next dev --port 3100',
  '  203   201 2097152 95.0 node vitest run',
  '  300     1   50000  1.0 node /h/.claude/skills/desk/bin/supervisor.mjs tick',
  '  301   300   40000  2.0 node /h/.claude/skills/desk/bin/pass.mjs',
  '  400     1 1048576 30.0 node /repo-worktrees/K-2/node_modules/.bin/next dev',
].join('\n');
{
  const procs = parsePs(PS);
  t('issue-1587 AC3 ps lines parse', [procs.length, procs[1]], [10, { pid: 100, ppid: 1, kb: 2097152, cpu: 40, cmd: '/Applications/IDE.app/ide' }]);
  t('issue-1587 AC3 only the IDE and browser count: workers, their servers and tests, desk itself and worktrees do not',
    othersHold(procs, { marks: ['/h/.claude/skills/desk/bin', '/repo-worktrees'], self: 301 }), { gb: 3, cpu: 1, procs: 2 });
  t('issue-1587 AC3 without the marks, desk\'s own processes would count', othersHold(procs, {}).procs, 5);
  const file = join(S, 'ps.txt');
  writeFileSync(file, PS);
  t('issue-1587 AC3 AUTOPILOT_PERSON_USE_PS stands in for ps', readProcs({ AUTOPILOT_PERSON_USE_PS: file }).length, 10);
}

// AC3 the mode: on at once while over the threshold, off only after calm-min minutes under it.
{
  const rows = personUseRows((k) => ({ 'memory-gb': '64', 'cpu-cores': '16', 'person-baseline-gb': '8', 'person-baseline-cpu': '1', 'person-use-gb': '4', 'person-use-cpu': '2', 'person-use-calm-min': '10' })[k] ?? null);
  const quiet = { gb: 9, cpu: 1.5 }, busy = { gb: 14, cpu: 1.5 }, hot = { gb: 9, cpu: 4 };
  t('issue-1587 AC3 under the threshold is not use', overThreshold(quiet, rows).over, false);
  t('issue-1587 AC3 memory over baseline + person-use-gb is use, and says by how much', overThreshold(busy, rows), { over: true, why: 'other processes hold 14 GB, 6 over the 8 GB baseline (person-use-gb 4)' });
  t('issue-1587 AC3 so is CPU over baseline + person-use-cpu', overThreshold(hot, rows).over, true);
  const at = (m) => new Date(Date.UTC(2026, 10, 27, 9, m)).toISOString();
  const on = nextMode(null, busy, rows, at(0));
  t('issue-1587 AC3 the mode switches on at the first reading over it', [on.on, on.since], [true, at(0)]);
  const calm1 = nextMode(on, quiet, rows, at(1));
  t('issue-1587 AC3 under it again, the mode stays on, counting from then', [calm1.on, calm1.since, calm1.calm_since], [true, at(0), at(1)]);
  const busyAgain = nextMode(calm1, busy, rows, at(5));
  t('issue-1587 AC3 back over it, the calm count starts again', [busyAgain.on, busyAgain.calm_since], [true, null]);
  const calm2 = nextMode(nextMode(busyAgain, quiet, rows, at(6)), quiet, rows, at(15));
  t('issue-1587 AC3 nine minutes under it is not enough', calm2.on, true);
  const off = nextMode(calm2, quiet, rows, at(16));
  t('issue-1587 AC3 the cap comes back once it has stayed under for person-use-calm-min', [off.on, off.why], [false, 'under the threshold for 10 min']);
  t('issue-1587 AC3 no reading keeps the mode as it was', nextMode(on, null, rows, at(2)).on, true);
  t('issue-1587 AC3 with person-use off, the mode is off', nextMode(on, busy, { ...rows, on: false }, at(2)).on, false);
}

// AC1 AC2 AC3 placement at start, by itself (the spawn loop's cases are in test_pass_spawn_loop.mjs).
{
  t('issue-1587 AC1 cloud_ok makes a ticket cloud-able, and so does an older location=cloud', [cloudAble({ cloud_ok: true }), cloudAble({ location: 'cloud' }), cloudAble({})], [true, true, false]);
  t('issue-1587 AC1 not once its PR is read: what follows runs here', cloudAble({ cloud_ok: true, location: 'cloud', result: { pr: 4 } }), false);
  t('issue-1587 nor once it has started on this computer: its work is in a local worktree', cloudAble({ cloud_ok: true, start_place: { where: 'local' } }), false);
  t('issue-1587 a resume of a cloud-able ticket runs here', startsInCloud({ cloud_ok: true, resume: 'pending' }), false);
  t('issue-1689 AC1 a pin to this computer overrides triage\'s runs: cloud, until location=auto clears it (stored as none)',
    [startsInCloud({ cloud_ok: true, location: 'local' }), startsInCloud({ cloud_ok: true, location: null })], [false, true]);
  t('issue-1689 AC3 a ticket moved local after its cloud session opened a PR goes on from that branch on origin; a plain pin is cut afresh',
    [fromCloudPr({ location: 'local', cloud: { pr_at: 'x' } }), fromCloudPr({ location: 'local' }), fromCloudPr({ location: 'cloud', cloud: { pr_at: 'x' } })], [true, false, true]);
  t('issue-1689 with its pin cleared (location=auto, stored as none), a ticket moved local still goes on from its PR branch and never back to the cloud',
    [fromCloudPr({ location: null, cloud_ok: true, cloud: { pr_at: 'x' } }), cloudAble({ location: null, cloud_ok: true, cloud: { pr_at: 'x' } })], [true, false]);
  const p = (o) => placeAtStart({ able: true, cloudRoom: false, localRoom: true, localSpare: true, free: 1, ...o }).where;
  t('issue-1587 AC2 cloud full: a local slot only with one free all last pass, one free now beyond the local-only reserve, and the person away',
    [p({}), p({ localSpare: false }), p({ reserve: 1 }), p({ personUse: true }), p({ localRoom: false, free: 0 })], ['local', null, null, null, null]);
  t('issue-1587 AC1 cloud room: the cloud, whatever the local slots', placeAtStart({ able: true, cloudRoom: true, localRoom: true, localSpare: true, free: 2 }).where, 'cloud');
  t('issue-1587 AC1 local-only: a local slot or a wait for one', [placeAtStart({ able: false, cloudRoom: true, localRoom: true }).where, placeAtStart({ able: false, cloudRoom: true, localRoom: false }).full], ['local', 'local']);
}

t('issue-1587 AC4 the mode line', modeLine(1), 'you\'re using this computer: local cap 1, cloud first');

process.exit(fails ? 1 : 0);
