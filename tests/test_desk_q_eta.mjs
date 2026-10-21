// suite: desk-q eta history (spawn to merge, per merged ticket)
// The eta history against a fixture queue, fixture worker logs and a temporary state directory, with
// a fake gh on PATH. Nothing touches your real queue, state or GitHub.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildHistory, recordMerge, readHistory, firstSpawnFromLogs } from '../desk/bin/desk-q-eta.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
// The CLI windows on the real clock, so the fixtures are dated from it.
const NOW = Date.now();
const hoursAgo = (h, from = NOW) => new Date(from - h * 3_600_000).toISOString();
const daysAgo = (d) => hoursAgo(d * 24);

// One stream-json log: the init line carries no stamp, the first event after it does.
const log = (stamp) => `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' })}\n${JSON.stringify({ type: 'user', timestamp: stamp })}\n${JSON.stringify({ type: 'user', timestamp: hoursAgo(-1, Date.parse(stamp)) })}\n`;

function world({ tickets, logs = {}, sizes = {}, merged = {} }) {
  const T = mkdtempSync(join(tmpdir(), 'desk-eta-'));
  const state = join(T, 'state');
  mkdirSync(join(state, 'logs'), { recursive: true });
  mkdirSync(join(state, 'triage'), { recursive: true });
  for (const [f, stamp] of Object.entries(logs)) writeFileSync(join(state, 'logs', f), stamp === '' ? '{"type":"system","subtype":"init"}\n' : log(stamp));
  for (const [k, size] of Object.entries(sizes)) writeFileSync(join(state, 'triage', `${k}.json`), JSON.stringify({ ticket: k, size }));
  const queue = { version: 1, batch: 'b', tickets };
  writeFileSync(join(T, 'queue.json'), JSON.stringify(queue));
  mkdirSync(join(T, 'stub'));
  writeFileSync(join(T, 'stub', 'gh'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(join(T, 'gh.log'))}, process.argv.slice(2).join(' ') + '\\n');\nconsole.log(JSON.stringify(${JSON.stringify(Object.entries(merged).map(([number, mergedAt]) => ({ number: Number(number), mergedAt })))}));\n`);
  chmodSync(join(T, 'stub', 'gh'), 0o755);
  const env = { ...process.env, PATH: `${join(T, 'stub')}:${process.env.PATH}`, DESK_QUEUE: join(T, 'queue.json'), DESK_AUTOPILOT_STATE: state, DESK_GH_REPO: 'acme/widgets', DESK_HOME: join(T, 'deskhome') };
  const run = (script, ...args) => spawnSync(process.execPath, [join(BIN, script), ...args], { cwd: T, env, encoding: 'utf8' });
  const lines = () => readHistory(state) ?? [];
  const queueNow = () => JSON.parse(readFileSync(join(T, 'queue.json'), 'utf8'));
  return { T, state, queue, run, lines, queueNow, ghCalls: () => (existsSync(join(T, 'gh.log')) ? readFileSync(join(T, 'gh.log'), 'utf8').trim().split('\n') : []) };
}

// ---- AC1: the merge lands on the ticket and as one line ----------------------------------------
{
  const w = world({ tickets: { 'DS-1': { key: 'DS-1', state: 'done', result: { pr: 1 }, spawned_at: hoursAgo(3) } }, sizes: { 'DS-1': 'S' } });
  writeFileSync(join(w.state, 'eta-history.jsonl'), '');
  const r = w.run('queue.mjs', 'merged', 'DS-1', hoursAgo(1));
  const mergedAt = w.queueNow().tickets['DS-1'].merged_at;
  t('AC1: queue.mjs merged exits 0', r.status, 0);
  t('AC1: the queue entry records the merge time', mergedAt, hoursAgo(1));
  t('AC1: one line with the key, size, first spawn, merge time and hours', w.lines(), [{ key: 'DS-1', size: 'S', spawned_at: hoursAgo(3), merged_at: hoursAgo(1), hours: 2 }]);
  w.run('queue.mjs', 'merged', 'DS-1', hoursAgo(0));
  t('AC1: a second merged call keeps the first merge time and adds no line', [w.queueNow().tickets['DS-1'].merged_at, w.lines().length], [hoursAgo(1), 1]);
}

// ---- AC2: the first build, from the queue, the logs and GitHub ---------------------------------
{
  const w = world({
    tickets: {
      'DS-10': { key: 'DS-10', state: 'done', merged_at: daysAgo(2), result: { pr: 10 } },
      'DS-11': { key: 'DS-11', state: 'done', result: { pr: 11 } },
      'DS-12': { key: 'DS-12', state: 'done', merged_at: daysAgo(3), result: { pr: 12 } },
      'DS-13': { key: 'DS-13', state: 'done', merged_at: daysAgo(40), result: { pr: 13 } },
      'DS-14': { key: 'DS-14', state: 'running' },
      'DS-15': { key: 'DS-15', state: 'done', result: { pr: 15 } },
    },
    // DS-10's first round started before its current log; DS-11's first round died before any stamp.
    logs: { 'DS-10.log.round1': hoursAgo(54), 'DS-10.log': hoursAgo(50), 'DS-11.log.round1': '', 'DS-11.log': hoursAgo(30), 'DS-13.log': daysAgo(41), 'DS-14.log': hoursAgo(2) },
    sizes: { 'DS-10': 'S', 'DS-11': 'm', 'DS-12': 'XS', 'DS-13': 'M' },
    merged: { 11: hoursAgo(24), 15: daysAgo(1) },
  });
  t('AC2: the first spawn is the earliest round with a stamp', firstSpawnFromLogs(w.state, 'DS-10'), hoursAgo(54));
  const r = w.run('desk-q-eta.mjs', 'build');
  t('AC2: the build exits 0', r.status, 0);
  t('AC2: one line per merged ticket in the window whose log records a spawn', w.lines().map((l) => [l.key, l.size, l.hours]), [['DS-10', 'S', 6], ['DS-11', 'M', 6]]);
  t('AC2: the build reports the merged tickets left out for having no spawn record', r.stdout.split('\n').find((l) => l.startsWith('left out')), 'left out 2 merged ticket(s) with no spawn record: DS-12, DS-15');
  t('AC2: merge times missing from the queue come from one gh pr list', w.ghCalls(), ['pr list --repo acme/widgets --state merged --limit 1000 --json number,mergedAt']);
}

// ---- AC3: a merge after the build adds one line and reads no log -------------------------------
{
  const w = world({
    tickets: {
      'DS-20': { key: 'DS-20', state: 'done', merged_at: daysAgo(1), result: { pr: 20 } },
      'DS-21': { key: 'DS-21', state: 'done', result: { pr: 21 }, spawned_at: hoursAgo(5) },
    },
    logs: { 'DS-20.log': hoursAgo(30), 'DS-21.log': hoursAgo(9) },
    sizes: { 'DS-20': 'S', 'DS-21': 'XS' },
  });
  w.run('desk-q-eta.mjs', 'build');
  const before = w.lines().length;
  const ghBefore = w.ghCalls().length;
  chmodSync(join(w.state, 'logs'), 0o000);
  const r = w.run('queue.mjs', 'merged', 'DS-21', hoursAgo(1));
  chmodSync(join(w.state, 'logs'), 0o755);
  t('AC3: the merge exits 0 with the logs unreadable', r.status, 0);
  t('AC3: the history gains exactly one line, from spawned_at', [before, w.lines().length, w.lines().at(-1)], [1, 2, { key: 'DS-21', size: 'XS', spawned_at: hoursAgo(5), merged_at: hoursAgo(1), hours: 4 }]);
  t('AC3: no GitHub lookup on a merge after the build', w.ghCalls().length - ghBefore, 0);
}

// ---- AC4: building again repeats nothing -------------------------------------------------------
{
  const w = world({
    tickets: { 'DS-30': { key: 'DS-30', state: 'done', merged_at: daysAgo(1), result: { pr: 30 } }, 'DS-31': { key: 'DS-31', state: 'done', merged_at: daysAgo(2), result: { pr: 31 } } },
    logs: { 'DS-30.log': daysAgo(1.5), 'DS-31.log': daysAgo(2.5) },
  });
  w.run('desk-q-eta.mjs', 'build');
  const r = w.run('desk-q-eta.mjs', 'build');
  const raw = readFileSync(join(w.state, 'eta-history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).key);
  t('AC4: a second build adds nothing and says so', r.stdout.trim(), 'eta history: 0 line(s) added, 2 already recorded');
  t('AC4: no ticket appears twice in the file', raw, ['DS-30', 'DS-31']);
  const again = buildHistory({ state: w.state, queue: w.queue, now: NOW });
  t('AC4: the module build is idempotent too', [again.added.length, again.already], [0, 2]);
}

// ---- AC5: no size is recorded as unknown -------------------------------------------------------
{
  const w = world({
    tickets: { 'DS-40': { key: 'DS-40', state: 'done', merged_at: hoursAgo(1), spawned_at: hoursAgo(2) }, 'DS-41': { key: 'DS-41', state: 'done', merged_at: hoursAgo(1), spawned_at: hoursAgo(3) } },
    sizes: { 'DS-41': '' },
  });
  writeFileSync(join(w.state, 'triage', 'DS-42.json'), '{ torn');
  const built = buildHistory({ state: w.state, queue: w.queue, now: NOW });
  t('AC5: a ticket with no triage record, or no size in it, is recorded as unknown', built.added.map((l) => [l.key, l.size]), [['DS-40', 'unknown'], ['DS-41', 'unknown']]);
  w.queue.tickets['DS-42'] = { key: 'DS-42', state: 'done', merged_at: hoursAgo(0), spawned_at: hoursAgo(1) };
  t('AC5: a torn triage record is unknown too, never guessed', recordMerge({ state: w.state, queue: w.queue, key: 'DS-42', now: NOW }).added.map((l) => l.size), ['unknown']);
}

console.log(fails ? `${fails} FAILED` : 'all eta history checks passed');
process.exit(fails ? 1 : 0);
