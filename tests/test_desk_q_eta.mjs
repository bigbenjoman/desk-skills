// suite: desk-q eta history (spawn to merge, per merged ticket) and ship forecast
// The eta history against a fixture queue, fixture worker logs and a temporary state directory, with
// a fake gh on PATH; then the forecast against fixture repos under a temporary HOME and DESK_HOME.
// Nothing touches your real queue, state or GitHub.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// ==== The forecast, against fixture repos under a throwaway HOME, DESK_HOME and config root.
// Every check but the CLI's runs on a fixed clock: Mon 19 Oct 2026 18:51, local time.
const FIXED = new Date(2026, 9, 19, 18, 51).getTime();
const HOUR = 3_600_000;
const Z = mkdtempSync(join(tmpdir(), 'desk-q-ships-'));
const zenv = { HOME: join(Z, 'home'), DESK_HOME: join(Z, 'deskhome'), DESK_CONFIG_ROOT: join(Z, 'config'), DESK_MACHINE: join(Z, 'machine.md') };
writeFileSync(zenv.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
const heldBy = (by) => ({ state: 'parked', held_by: by, park: { question: `held by orchestrator: blocked by ${by}` } });

// One repo: its config, queue, triage sizes and history. `history` is [size, hours] per merged
// ticket, each merged an hour before the last, counting back from `at`. Its last pass is `pass`
// (default `at`, so it is live then); null means no pass yet.
function repo(name, port, { workers = 2, tickets, sizes = {}, epics = {}, history, at = FIXED, pass = at }) {
  const slug = `acme__${name}`;
  mkdirSync(join(zenv.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(zenv.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${port}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`${workers} / 3\` |\n`);
  const qp = join(zenv.DESK_HOME, 'repos', slug, 'queue.json');
  mkdirSync(dirname(qp), { recursive: true });
  writeFileSync(qp, JSON.stringify({ version: 1, batch: name, concurrency: workers, tickets: Object.fromEntries(Object.entries(tickets).map(([k, v]) => [k, { key: k, ...v }])) }));
  const state = join(zenv.HOME, '.desk-autopilot', slug);
  mkdirSync(join(state, 'triage'), { recursive: true });
  for (const [k, size] of Object.entries(sizes)) writeFileSync(join(state, 'triage', `${k}.json`), JSON.stringify({ ticket: k, summary: `${k} title`, size, ...(epics[k] ? { epic: epics[k] } : {}) }));
  if (pass != null) {
    mkdirSync(join(state, 'orchestrators'), { recursive: true });
    writeFileSync(join(state, 'orchestrators', 'q.json'), JSON.stringify({ queue: qp, batch: name, pid: 1, at: new Date(pass).toISOString() }));
  }
  writeFileSync(join(state, 'eta-history.jsonl'), history.map(([size, hours], i) => {
    const merged = at - (i + 1) * HOUR;
    return `${JSON.stringify({ key: `H-${i}`, size, spawned_at: new Date(merged - hours * HOUR).toISOString(), merged_at: new Date(merged).toISOString(), hours })}\n`;
  }).join(''));
}

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
// desk-skills is read by the CLI on the real clock, so its history is dated from it.
repo('desk-skills', 3500, {
  tickets: { 'DS-1': { state: 'running', stage: '6/9' }, 'DS-2': { state: 'triaged' }, 'DS-3': { state: 'parked', park: { question: 'which copy?' } }, 'DS-4': heldBy('DS-2') },
  sizes: { 'DS-1': 'M', 'DS-2': 'M', 'DS-3': 'S', 'DS-4': 'M' },
  history: range(12, (i) => ['M', 2 + (i % 5)]), at: Date.now(),
});
repo('alpha', 3100, {
  tickets: {
    'A-1': { state: 'running', stage: '6/9' },
    'A-2': { state: 'triaged' },
    'A-3': { state: 'triaged', collides_with: 'A-4' },
    'A-4': { state: 'triaged', collides_with: 'A-3' },
    'A-5': heldBy('A-3'),
    'A-6': { state: 'parked', park: { question: 'which copy?' } },
    'A-7': heldBy('A-6'),
  },
  sizes: { 'A-1': 'M', 'A-2': 'S', 'A-3': 'M', 'A-4': 'M', 'A-5': 'S', 'A-6': 'M', 'A-7': 'S' },
  history: [...range(6, (i) => ['S', 1 + i]), ...range(6, (i) => ['M', 2 + i])],
});
// beta has no size L history, only 3 of size M, and B-2 has no triage record at all.
repo('beta', 3300, {
  workers: 3,
  tickets: { 'B-1': { state: 'triaged' }, 'B-2': { state: 'triaged' }, 'B-3': { state: 'triaged' } },
  sizes: { 'B-1': 'L', 'B-3': 'M' },
  history: [...range(10, (i) => ['S', 1 + i]), ...range(3, (i) => ['M', 2 + i])],
});
repo('nine', 3200, { tickets: { 'N-1': { state: 'triaged' } }, sizes: { 'N-1': 'S' }, history: range(9, () => ['S', 2]) });

// ---- forecast AC1: `desk-q ships <repo> --plain` from the shell
const DESK_Q = join(BIN, 'desk-q.mjs');
const cli = (...args) => spawnSync(process.execPath, [DESK_Q, ...args], { encoding: 'utf8', env: { ...zenv, PATH: process.env.PATH } });
const shipped = cli('ships', 'desk-skills', '--plain');
const dsRows = shipped.stdout.split('\n').filter((l) => /^ {2}DS-\d+ /.test(l));
t('DS-161 AC1: ships exits 0', shipped.status, 0);
t('DS-161 AC1: a STARTS and SHIPS header', shipped.stdout.split('\n').some((l) => /^ {2}TICKET\s+STATE\s+STARTS\s+SHIPS$/.test(l)), true);
t('DS-161 AC1: one line per unfinished ticket, with its key and state', dsRows.map((l) => l.trim().split(/\s+/).slice(0, 2).join(' ')), ['DS-1 running', 'DS-2 ready', 'DS-3 needs', 'DS-4 waiting']);
t('DS-161 AC1: the running and ready rows carry a start and a ship time', [/^ {2}DS-1\s+running\s+running\s+\S/.test(dsRows[0]), /^ {2}DS-2\s+ready\s+now\s+\S/.test(dsRows[1])], [true, true]);
t('DS-161 AC1: when is an alias of ships', cli('when', 'desk-skills', '--plain').stdout.split('\n').filter((l) => /^ {2}DS-\d+ /.test(l)).length, 4);

Object.assign(process.env, zenv);
const Q = await import(DESK_Q);
const { forecast, when } = await import('../desk/bin/desk-q-eta.mjs');
const alpha = Q.loadRepos(FIXED).find((r) => r.name === 'alpha');
const F = Q.forecastOf(alpha, { now: FIXED });
const show = (key, opts = {}) => Q.ticketScreen(alpha, key, { now: FIXED, ...opts }).split('\n');

// ---- forecast AC2 and AC3: a hold and a collision each wait for the other ticket's ship time
t('DS-161 AC2: a waiting ticket starts no earlier than its blocker ships', F.T['A-5'].start >= F.T['A-3'].likely, true);
t('DS-161 AC3: of two colliding tickets, the later starts no earlier than the earlier ships', F.T['A-4'].start >= F.T['A-3'].likely, true);

// ---- forecast AC4: running and ready-now on the repo screen
const alphaRows = Q.repoScreen(alpha, { now: FIXED }).split('\n');
const rowFor = (rows, key) => rows.find((l) => new RegExp(`^\\s+\\*?\\d+\\s+${key}\\s`).test(l)) ?? '';
t('DS-161 AC4: a running ticket starts "running"', /A-1\s+running\s+stage 6\/9\s+running\s+\S/.test(rowFor(alphaRows, 'A-1')), true);
t('DS-161 AC4: a ready ticket a free worker takes starts "now"', /A-2\s+ready\s+now\s+\S/.test(rowFor(alphaRows, 'A-2')), true);

// ---- forecast AC5 and AC6: no date while it waits on the user, or is stuck
t('DS-161 AC5: a ticket waiting on the user has no date', F.T['A-6'], null);
t('DS-161 AC5: and its screen says to answer it, or press c', show('A-6').includes('Ships: No date until you answer it. Press c to date it at the next check-in.'), true);
t('DS-161 AC6: a stuck ticket has no date', F.T['A-7'], null);
t('DS-161 AC6: and its screen names the ticket blocking it', show('A-7').includes('Ships: No date while it is stuck behind A-6. Unblock it to date it.'), true);

// ---- forecast AC7: too little history gives no dates
const nine = Q.run(['ships', 'nine', '--plain'], { now: FIXED });
t('DS-161 AC7: 9 merged tickets: says so, and that estimates need 10', nine, 'nine · No ship estimate: nine has 9 merged autopilot tickets in its history (the last 30 days), and estimates need 10.');

// ---- forecast AC8: dates counted in calendar days
const at = (...a) => new Date(...a).getTime();
t('DS-161 AC8: today, the next 6 days, a week out, and another year', [at(2026, 9, 19, 21, 30), at(2026, 9, 22, 14, 30), at(2026, 9, 26, 10, 0), at(2027, 0, 4, 9, 0)].map((x) => when(x, FIXED)),
  ['today 21:30', 'Thu 14:30', '26 Oct', '4 Jan 2027']);

// ---- forecast AC9: STARTS and SHIPS on the queue, QUEUE DONE on the overview
t('DS-161 AC9: the queue screen has STARTS and SHIPS columns', alphaRows.some((l) => /^\s+#\s+TICKET\s+STATE\s+DETAIL\s+STARTS\s+SHIPS\s+TITLE$/.test(l)), true);
const ov = Q.overview(Q.loadRepos(FIXED), { now: FIXED, avail: 30, all: true }).split('\n');
t('DS-161 AC9: the overview has a QUEUE DONE column', ov.some((l) => /DONE\s+QUEUE DONE\s+WORKERS$/.test(l)), true);
t('DS-161 AC9: giving when the repo\'s last dated ticket ships', (ov.find((l) => /^ {2}alpha /.test(l)) ?? '').includes(`  ${when(F.clears, FIXED)}`), true);

// ---- forecast AC10: the ticket screen's dates and the history behind them
const a3 = show('A-3');
const i3 = a3.findIndex((l) => l.startsWith('Starts: '));
t('DS-161 AC10: starts, ships and could run to', /^Starts: \S.*? {3}Ships: \S.*? {3}Could run to \S.*? \(1 run in 5 is later\)$/.test(a3[i3] ?? ''), true);
t('DS-161 AC10: could run to is no earlier than ships', F.T['A-3'].late >= F.T['A-3'].likely, true);
t('DS-161 AC10: then how many merged tickets of its size the history holds', (a3[i3 + 1] ?? '').startsWith('From 6 merged size M tickets in alpha: typical '), true);
const beta = Q.loadRepos(FIXED).find((r) => r.name === 'beta');
const histLine = (key) => { const l = Q.ticketScreen(beta, key, { now: FIXED }).split('\n'); return l[l.findIndex((x) => x.startsWith('Starts: ')) + 1] ?? ''; };
t('DS-161 AC10: a size the history has none of still names its count, 0', histLine('B-1').startsWith('From 13 merged tickets in beta (0 of size L): typical '), true);
t('DS-161 AC10: a ticket triage gave no size says so', histLine('B-2').startsWith('From 13 merged tickets in beta (triage recorded no size): typical '), true);
t('DS-161 AC10: a size with too few to use alone names its count', histLine('B-3').startsWith('From 13 merged tickets in beta (3 of size M, too few to use alone): typical '), true);

// ---- forecast AC11: the same files and clock give the same dates
const rows = alpha.rows.map(({ t: tk, k }) => ({ key: tk.key, k, size: 'M', stage: tk.stage, held: String(tk.held_by ?? '').split('|').filter(Boolean), collides: String(tk.collides_with ?? '').split('|').filter(Boolean) }));
const hist = range(12, (i) => ({ size: 'M', hours: 1 + i }));
t('DS-161 AC11: two forecasts over the same input are identical', JSON.stringify(forecast({ rows, workers: 2, history: hist, now: FIXED })) === JSON.stringify(forecast({ rows, workers: 2, history: hist, now: FIXED })), true);
// A second copy of the module has its own empty cache, so its ships runs the simulation afresh.
const Q2 = await import(`${pathToFileURL(DESK_Q).href}?again`);
t('DS-161 AC11: and ships prints the same dates twice', Q2.run(['ships', 'alpha', '--plain'], { now: FIXED }), Q.run(['ships', 'alpha', '--plain'], { now: FIXED }));

// ---- forecast AC12: c dates tickets waiting on the user at the next check-in, and c again undoes it
const { PassThrough } = await import('node:stream');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const input = new PassThrough();
Object.assign(input, { isTTY: true, setRawMode: () => {} });
const output = { buf: '', columns: 160, rows: 40, write(s) { this.buf += s; }, on() {}, removeListener() {} };
const ui = Q.interactive({ input, output, start: { kind: 'repo', slug: 'acme__alpha' }, exit: () => {}, refreshMs: 600000, clock: () => FIXED });
const frame = () => output.buf.split('\x1b[H').at(-1).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\r\n');
const a6 = () => frame().find((l) => /\sA-6\s/.test(l)) ?? '';
// The note follows the tab line, under the breadcrumb (DS-164).
const note = () => frame()[1];
await sleep(20);
t('DS-161 AC12: before c, the header says parked tickets have no date', note().endsWith('Parked: no date · c to date them at check-ins') && /no date/.test(a6()), true);
input.write('c'); await sleep(20);
t('DS-161 AC12: after c, the header says they are dated at the next check-in', note().endsWith('Parked: dated at the next check-in · c to undo'), true);
t('DS-161 AC12: and the ticket waiting on the user has a date', a6().includes(`  ${when(Q.forecastOf(alpha, { now: FIXED, checkin: true }).T['A-6'].likely, FIXED)}  `) && !/no date/.test(a6()), true);
t('DS-161 AC12: from no earlier than the next check-in, Tue 08:00', Q.forecastOf(alpha, { now: FIXED, checkin: true }).T['A-6'].start >= at(2026, 9, 20, 8, 0), true);
input.write('c'); await sleep(20);
t('DS-161 AC12: c again takes the dates away', note().endsWith('Parked: no date · c to date them at check-ins') && /no date/.test(a6()), true);
ui.finish(0);

// ==== DS-162: each ticket's first estimate, kept beside its merge, and how often it held.
const { readEstimates } = await import('../desk/bin/desk-q-eta.mjs');
const stateOf = (name) => join(zenv.HOME, '.desk-autopilot', `acme__${name}`);
const repoAt = (name, now = FIXED) => Q.loadRepos(now).find((r) => r.name === name);
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

// ---- AC1: the first forecast to date a ticket saves it; a later one leaves it alone
repo('gamma', 3600, {
  tickets: { 'G-1': { state: 'triaged' }, 'G-2': { state: 'triaged' }, 'G-3': { state: 'parked', park: { question: 'which copy?' } } },
  sizes: { 'G-1': 'M', 'G-2': 'M', 'G-3': 'M' }, history: range(12, (i) => ['M', 2 + (i % 5)]),
});
const gF = Q.forecastOf(repoAt('gamma'), { now: FIXED });
const g1 = readEstimates(stateOf('gamma')).get('G-1');
t('DS-162 AC1: the first forecast saves its starts, ships and could-run-to times', g1 && [g1.at, g1.starts, g1.ships, g1.could_run_to],
  [iso(FIXED), iso(gF.T['G-1'].start), iso(gF.T['G-1'].likely), iso(gF.T['G-1'].late)]);
const gFile = () => readFileSync(join(stateOf('gamma'), 'eta.jsonl'), 'utf8');
const gBefore = gFile();
const gLater = Q.forecastOf(repoAt('gamma', FIXED + 10 * MIN), { now: FIXED + 10 * MIN });
Q.forecastOf(repoAt('gamma', FIXED + 10 * MIN), { now: FIXED + 10 * MIN, checkin: true });
t('DS-162 AC1: a later forecast with other dates does not overwrite it', [gLater.T['G-1'].likely !== gF.T['G-1'].likely, gFile() === gBefore], [true, true]);
t('DS-162 AC1: a ticket dated only at the next check-in (c) saves no estimate', readEstimates(stateOf('gamma')).has('G-3'), false);

// ---- AC2: the merge time goes beside the saved estimate
const gQueue = join(zenv.DESK_HOME, 'repos', 'acme__gamma', 'queue.json');
const merge = (key, when) => spawnSync(process.execPath, [join(BIN, 'queue.mjs'), 'merged', key, when], { encoding: 'utf8',
  env: { ...process.env, ...zenv, DESK_QUEUE: gQueue, DESK_AUTOPILOT_STATE: stateOf('gamma'), DESK_GH_REPO: 'acme/gamma' } });
const m1 = merge('G-1', iso(FIXED + 3 * HOUR));
t('DS-162 AC2: queue.mjs merged exits 0 and says the estimate was kept', [m1.status, /first estimate kept with its merge/.test(m1.stdout)], [0, true]);
t('DS-162 AC2: the merge time is saved beside the estimate', readEstimates(stateOf('gamma')).get('G-1'), { ...g1, merged_at: iso(FIXED + 3 * HOUR) });
merge('G-1', iso(FIXED + 5 * HOUR));
t('DS-162 AC2: a second merged call keeps the first merge time', readEstimates(stateOf('gamma')).get('G-1').merged_at, iso(FIXED + 3 * HOUR));

// Saved estimates, oldest merge first: [shipped before could-run-to?] per ticket.
const saved = (name, hits) => writeFileSync(join(stateOf(name), 'eta.jsonl'), hits.flatMap((hit, i) => {
  const merged = FIXED - (hits.length - i) * HOUR;
  return [{ key: `E-${i}`, at: iso(merged - 5 * HOUR), starts: iso(merged - 5 * HOUR), ships: iso(merged - HOUR), could_run_to: iso(merged + (hit ? HOUR : -HOUR / 2)) },
    { key: `E-${i}`, merged_at: iso(merged) }];
}).map((l) => `${JSON.stringify(l)}\n`).join(''));

// ---- AC3: 31 of the last 40 merged before their could-run-to time; 5 older misses do not count
repo('hits', 3700, { tickets: { 'X-1': { state: 'triaged' } }, sizes: { 'X-1': 'M' }, history: range(12, (i) => ['M', 2 + (i % 5)]) });
saved('hits', [...range(5, () => false), ...range(40, (i) => i % 40 >= 9)]);
const RATE = '78% shipped before their could-run-to time (last 40 tickets)';
t('DS-162 AC3: the Timeline header gives the hit rate', Q.timelineScreen(Q.loadRepos(FIXED), 'acme__hits', { now: FIXED }).split('\n').slice(0, 3).includes(RATE), true);
t('DS-162 AC3: and so does --plain', Q.run(['ships', 'hits', '--plain'], { now: FIXED }).split('\n').slice(0, 3).includes(RATE), true);

// ---- AC4: no pass for 15 minutes marks the dates paused
repo('quiet', 3800, { tickets: { 'Q-1': { state: 'triaged' } }, sizes: { 'Q-1': 'M' }, history: range(12, (i) => ['M', 2 + (i % 5)]), pass: FIXED - 20 * MIN });
const quiet = repoAt('quiet');
const PAUSED = 'Dates paused: no pass for 20m. The forecast assumes passes keep running, so dates show again at the next pass.';
t('DS-162 AC4: ships says the dates are paused, and shows none', Q.run(['ships', 'quiet', '--plain'], { now: FIXED }), `quiet · ${PAUSED}`);
t('DS-162 AC4: the queue screen marks STARTS and SHIPS paused', /\sQ-1\s+ready\s+paused\s+paused\s/.test(Q.repoScreen(quiet, { now: FIXED })), true);
t('DS-162 AC4: the ticket screen says so in place of its dates', Q.ticketScreen(quiet, 'Q-1', { now: FIXED }).split('\n').includes(`Ships: ${PAUSED}`), true);
t('DS-162 AC4: the overview\'s QUEUE DONE reads paused', /\spaused\s/.test(Q.overview(Q.loadRepos(FIXED), { now: FIXED, avail: 30, all: true }).split('\n').find((l) => /^ {2}quiet /.test(l)) ?? ''), true);
t('DS-162 AC4: and a paused forecast saves no estimate', readEstimates(stateOf('quiet')).size, 0);

// ---- AC5: under 10 merged estimates, no percentage
repo('few', 3900, { tickets: { 'F-1': { state: 'triaged' } }, sizes: { 'F-1': 'M' }, history: range(12, (i) => ['M', 2 + (i % 5)]) });
saved('few', range(9, () => true));
const fewHead = Q.timelineScreen(Q.loadRepos(FIXED), 'acme__few', { now: FIXED }).split('\n').slice(0, 3);
t('DS-162 AC5: 9 merged estimates give no percentage, and say a rate needs 10', [fewHead.some((l) => l.includes('%')), fewHead[1]],
  [false, 'No hit rate yet: 9 merged tickets have a saved first estimate, and a rate needs 10.']);

// ==== DS-165: each epic dated as the moment its last child merges, inside the same runs.
const { epicFact } = await import('../desk/bin/desk-q-eta.mjs');

// ---- AC1: triage records the parent epic's key and summary, from Jira's parent field
const epicType = { name: 'Epic', hierarchyLevel: 1 };
const issueUnder = (type) => ({ key: 'V-1', fields: { parent: { key: 'EP-1', fields: { summary: 'Smart scheduling, your day', issuetype: type } } } });
const kidsJson = [{ key: 'V-1', fields: { status: { statusCategory: { key: 'new' } } } }, { key: 'V-4', fields: { status: { statusCategory: { key: 'done' } } } }];
t('DS-165 AC1: a ticket under an epic records its key, summary and children', epicFact(issueUnder(epicType), kidsJson),
  { key: 'EP-1', summary: 'Smart scheduling, your day', children: [{ key: 'V-1', done: false }, { key: 'V-4', done: true }] });
t('DS-165 AC1: a parent that is not an epic, or none, records no epic', [epicFact(issueUnder({ name: 'Story', hierarchyLevel: 0 }), kidsJson), epicFact({ fields: {} }, null)], [null, null]);
t('DS-165 AC1: a children read that failed leaves the list out', epicFact(issueUnder(epicType), null), { key: 'EP-1', summary: 'Smart scheduling, your day' });

// One repo with an epic of each kind, and one ticket with none.
const ep = (key, summary, kids) => ({ key, summary, children: kids.map(([k, done = false]) => ({ key: k, done })) });
const EP1 = ep('EP-1', 'Smart scheduling, your day', [['V-1'], ['V-2'], ['V-3'], ['V-4', true]]);
const EP2 = ep('EP-2', 'Beats', [['V-5'], ['V-6'], ['V-7']]);
const EP3 = ep('EP-3', 'Notes', [['V-8'], ['V-9']]);
const EP4 = ep('EP-4', 'Sign-in', [['V-10', true], ['V-11', true]]);
repo('voicepa', 4000, {
  tickets: {
    'V-1': { state: 'running', stage: '6/9' }, 'V-2': { state: 'triaged' }, 'V-3': heldBy('V-2'), 'V-4': { state: 'done', merged_at: iso(FIXED - 2 * HOUR) },
    'V-5': { state: 'triaged' },
    'V-8': { state: 'parked', park: { question: 'which copy?' } }, 'V-9': { state: 'triaged' },
    'V-10': { state: 'done', merged_at: iso(FIXED - 5 * HOUR) },
    'V-12': { state: 'triaged' },
  },
  sizes: Object.fromEntries(['V-1', 'V-2', 'V-3', 'V-4', 'V-5', 'V-8', 'V-9', 'V-10', 'V-12'].map((k) => [k, 'M'])),
  epics: { 'V-1': EP1, 'V-2': EP1, 'V-3': EP1, 'V-4': EP1, 'V-5': EP2, 'V-8': EP3, 'V-9': EP3, 'V-10': EP4 },
  history: range(12, (i) => ['M', 2 + (i % 5)]),
});
const vp = repoAt('voicepa');
const VF = Q.forecastOf(vp, { now: FIXED });
const vShips = Q.run(['ships', 'voicepa', '--plain'], { now: FIXED }).split('\n');
const epicRow = (key) => vShips.find((l) => l.startsWith(`  ${key} `)) ?? '';

// ---- AC2: an epic ships no earlier than its slowest child, and starts with its first
const kids1 = ['V-1', 'V-2', 'V-3'];
t('DS-165 AC2: the epic ships no earlier than its slowest child ships', VF.E['EP-1'].likely >= Math.max(...kids1.map((k) => VF.T[k].likely)), true);
t('DS-165 AC2: its starts is its first child\'s starts', VF.E['EP-1'].start, Math.min(...kids1.map((k) => VF.T[k].start)));
t('DS-165 AC2: and its could-run-to is no earlier than its ships', VF.E['EP-1'].late >= VF.E['EP-1'].likely, true);

// ---- AC3: children not queued yet make the date provisional, with the count
t('DS-165 AC3: an epic with children not queued still gets a date', VF.E['EP-2'] != null, true);
t('DS-165 AC3: marked provisional, saying how many are not queued', epicRow('EP-2').endsWith(`${when(VF.E['EP-2'].likely, FIXED).padEnd(14)}provisional: 2 not queued`), true);
t('DS-165 AC3: no earlier than its queued child ships', VF.E['EP-2'].likely >= VF.T['V-5'].likely, true);

// ---- AC4: a child waiting on the user leaves the epic undated
t('DS-165 AC4: an epic with a child waiting on the user has no date', VF.E['EP-3'], null);
t('DS-165 AC4: and says so, with c', epicRow('EP-3').endsWith('No date: 1 waiting on you · c to date them at check-ins'), true);

// ---- AC5: every child done shows when it shipped
t('DS-165 AC5: an epic whose children are all done shows when it shipped', /\s2\/2\s+—\s+shipped today 13:51$/.test(epicRow('EP-4')), true);

// ---- AC6: ships --plain prints one line per epic with children in the queue
t('DS-165 AC6: an EPICS header after the tickets', vShips.some((l) => /^ {2}EPIC\s+TITLE\s+DONE\s+STARTS\s+SHIPS$/.test(l)), true);
t('DS-165 AC6: one line per epic, with key, summary and children done of total', vShips.filter((l) => /^ {2}EP-\d+ /.test(l)).map((l) => l.slice(2, 51).replace(/\s+/g, ' ').trim()),
  ['EP-1 Smart scheduling, your day 1/4', 'EP-2 Beats 0/3', 'EP-3 Notes 0/2', 'EP-4 Sign-in 2/2']);
t('DS-165 AC6: a dated epic gives STARTS and SHIPS, and the child that sets it', epicRow('EP-1').endsWith(`running      ${when(VF.E['EP-1'].likely, FIXED).padEnd(14)}set by ${VF.E['EP-1'].setBy}`), true);

// ---- AC7: a ticket with no epic is dated as before, and counted
const vRows = vp.rows.map(({ t: tk, k }) => ({ key: tk.key, k, size: 'M', stage: tk.stage ?? null, held: String(tk.held_by ?? '').split('|').filter(Boolean), collides: [], epic: VF.of[tk.key] ?? null }));
const vHist = recentHistoryOf('voicepa');
t('DS-165 AC7: the tickets are dated exactly as with no epics at all', forecast({ rows: vRows, workers: 2, history: vHist, now: FIXED }).T, VF.T);
t('DS-165 AC7: a ticket with no epic has a date', VF.T['V-12'] != null, true);
t('DS-165 AC7: and is counted as having no epic', [VF.noEpic, vShips.includes('Other work: 1 ticket with no epic.')], [1, true]);

// ---- review round 1: an epic with nothing queued and an unread children list has shipped; no workers, no date
const { epicsOf } = await import('../desk/bin/desk-q-eta.mjs');
const unread = epicsOf({ 'U-1': { state: 'done', merged_at: iso(FIXED - HOUR) } }, { 'U-1': { epic: { key: 'EP-9', summary: 'Unread' } } }).epics['EP-9'];
t('DS-165 fix: an epic whose children were not read reads as unknown, not as none missing', [unread.queued, unread.missing], [0, null]);
repo('unread', 4100, {
  tickets: { 'U-1': { state: 'done', merged_at: iso(FIXED - HOUR) }, 'U-2': { state: 'triaged' } },
  sizes: { 'U-1': 'M', 'U-2': 'M' }, epics: { 'U-1': { key: 'EP-9', summary: 'Unread' } }, history: range(12, (i) => ['M', 2 + (i % 5)]),
});
t('DS-165 fix: and with nothing queued it shows as shipped, not run forward',
  [Q.forecastOf(repoAt('unread'), { now: FIXED }).E['EP-9'], Q.run(['ships', 'unread', '--plain'], { now: FIXED }).split('\n').find((l) => l.startsWith('  EP-9 '))?.endsWith('shipped today 17:51 · children not read')], [undefined, true]);
t('DS-165 fix: with workers set to 0, children not queued leave the epic undated',
  forecast({ rows: [], workers: 0, history: vHist, now: FIXED, epics: { 'EP-9': { missing: 2 } } }).E['EP-9'], null);

function recentHistoryOf(name) { return readFileSync(join(stateOf(name), 'eta-history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); }

console.log(fails ? `${fails} FAILED` : 'all eta history checks passed');
process.exit(fails ? 1 : 0);
