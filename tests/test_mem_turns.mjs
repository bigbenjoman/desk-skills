// suite: memory turns (one free-memory floor for CI and autopilot, and turns between them)
// mem-turns.mjs against markers in a throwaway DESK_HOME, with the available memory, the VM's resident
// memory and the machine profile injected; then its CLI, as desk-runner calls it. Nothing touches your
// real ~/.claude, ~/.config/desk or state.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-mem-turns-'));
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md') };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_CONFIG', 'AUTOPILOT_MIN_AVAIL_GB', 'DESK_MEM_AVAIL_GB', 'DESK_RUNNER_RESIDENT_GB']) delete process.env[k];
Object.assign(process.env, env);
const profile = (rows) => writeFileSync(env.DESK_MACHINE, `## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n${rows.map(([k, v]) => `| ${k} | \`${v}\` | x |\n`).join('')}`);
profile([]);
const M = await import(join(BIN, 'mem-turns.mjs'));
const E = await import(join(BIN, 'desk-env.mjs'));

const NOW = Date.now();
const DIR = join(T, 'turns');
const marker = (name, m) => { mkdirSync(DIR, { recursive: true }); writeFileSync(join(DIR, `${name}.json`), JSON.stringify(m)); };
const minsAgo = (m) => NOW - m * 60000;
// A batch's heartbeat, as the orchestrator writes it, so an autopilot marker reads as live.
const STATE = join(T, 'state');
const QUEUE = join(T, 'queue.json');
mkdirSync(join(STATE, 'orchestrators'), { recursive: true });
writeFileSync(join(STATE, 'orchestrators', 'o.json'), JSON.stringify({ queue: QUEUE, at: new Date(NOW - 60000).toISOString() }));
const ap = (since, extra = {}) => ({ side: 'autopilot', since, at: NOW - 60000, why: '1 ticket(s) ready', state: STATE, queue: QUEUE, ...extra });
const ci = (since, extra = {}) => ({ side: 'ci', since, at: NOW - 60000, why: 'slot', pid: process.pid, ...extra });

// ---- the claim, and the floor (AC1, AC4, AC7)
t('AC1: the first slot claims its limit plus 2 GB for the VM, less what the VM holds', M.slotClaim({ slotGB: 7, running: 0, residentGB: 3 }), 6);
t('a claim with slots running counts each slot', M.slotClaim({ slotGB: 7, running: 1, residentGB: 9 }), 7);
t('a claim never goes below 0', M.slotClaim({ slotGB: 7, running: 0, residentGB: 20 }), 0);
const ac1 = M.ciTurn({ avail: 12, floor: 8, slotGB: 7, running: 0, residentGB: 3, live: [] });
t('AC1: 12G available, a 6G claim and an 8G floor: the slot waits', ac1.go, false);
t('AC1: why says what it would leave', /would leave 6\.0G, under the 8G floor/.test(ac1.why), true);
t('a claim that leaves the floor standing starts the slot', M.ciTurn({ avail: 14, floor: 8, slotGB: 7, running: 0, residentGB: 3, live: [] }).go, true);
t('AC4: no slot running, autopilot waiting: the first slot starts while the floor holds',
  M.ciTurn({ avail: 20, floor: 8, slotGB: 7, running: 0, residentGB: 3, live: [{ ...ap(minsAgo(5)), name: 'autopilot-r' }] }).go, true);
t('AC4: the first slot still keeps the floor', M.ciTurn({ avail: 12, floor: 8, slotGB: 7, running: 0, residentGB: 3, live: [{ ...ap(minsAgo(5)), name: 'autopilot-r' }] }).go, false);
t('AC7: the floor is 8 with no profile key', E.memoryFloor(undefined), 8);
t('AC7: the profile key sets the floor', E.memoryFloor('12'), 12);
t('AC7: a key that is not a number above 0 reads as 8', E.memoryFloor('nope'), 8);
t('AC7: a higher floor holds a slot a lower one starts', M.ciTurn({ avail: 20, floor: 16, slotGB: 7, running: 0, residentGB: 3, live: [] }).go, false);
profile([['runner-memory-floor-gb', '12']]);
t('AC7: the spawn gate starts at the floor when it is higher', spawnSync('node', ['-e', `import(${JSON.stringify(join(BIN, 'desk-env.mjs'))}).then((E) => console.log(E.spawnGate('above 8, below 4').start))`], { encoding: 'utf8' }).stdout.trim(), '12');
t('AC7: a repo gate above the floor is kept', spawnSync('node', ['-e', `import(${JSON.stringify(join(BIN, 'desk-env.mjs'))}).then((E) => console.log(E.spawnGate('above 14, below 4').start))`], { encoding: 'utf8' }).stdout.trim(), '14');
profile([]);

// ---- turns (AC2, AC3, AC5)
const live = (...ms) => ms.map(([name, m]) => ({ ...m, name })).sort((a, b) => a.since - b.since);
t('AC3: a slot running and autopilot waiting: the next slot waits',
  M.ciTurn({ avail: 30, floor: 8, slotGB: 7, running: 1, residentGB: 9, live: live(['autopilot-r', ap(minsAgo(5))]) }).go, false);
t('AC3: why names autopilot', /autopilot's turn: autopilot \(r\) waiting for memory/.test(M.ciTurn({ avail: 30, floor: 8, slotGB: 7, running: 1, residentGB: 9, live: live(['autopilot-r', ap(minsAgo(5))]) }).why), true);
t('AC2: CI waiting holds the batch\'s next worker', M.ciHolds({ running: 1, live: live(['ci', ci(minsAgo(5))]), self: 'autopilot-r' })?.name, 'ci');
t('AC2: CI waiting never holds the batch\'s first worker', M.ciHolds({ running: 0, live: live(['ci', ci(minsAgo(5))]), self: 'autopilot-r' }), null);
const both = live(['ci', ci(minsAgo(10))], ['autopilot-r', ap(minsAgo(5))]);
t('AC5: CI waited first: it starts once memory frees', M.ciTurn({ avail: 30, floor: 8, slotGB: 7, running: 1, residentGB: 9, live: both }).go, true);
t('AC5: CI waited first: the batch stays held', M.ciHolds({ running: 1, live: both, self: 'autopilot-r' })?.name, 'ci');
const both2 = live(['ci', ci(minsAgo(5))], ['autopilot-r', ap(minsAgo(10))]);
t('AC5: autopilot waited first: the slot stays held', M.ciTurn({ avail: 30, floor: 8, slotGB: 7, running: 1, residentGB: 9, live: both2 }).go, false);
t('AC5: autopilot waited first: the batch goes', M.ciHolds({ running: 1, live: both2, self: 'autopilot-r' }), null);

// ---- markers (AC6)
marker('ci', ci(minsAgo(3)));
marker('autopilot-r', ap(minsAgo(2)));
let r = M.readTurns({ dir: DIR, now: NOW });
t('live markers are read, oldest wait first', r.live.map((m) => m.name).join(' '), 'ci autopilot-r');
t('live markers are kept', r.removed.length, 0);
marker('ci', ci(minsAgo(40), { at: minsAgo(31) }));
r = M.readTurns({ dir: DIR, now: NOW });
t('AC6: a marker not rewritten for 30 minutes is ignored', r.live.map((m) => m.name).join(' '), 'autopilot-r');
t('AC6: and removed', existsSync(join(DIR, 'ci.json')), false);
t('AC6: and the log says so', r.removed[0], "memory turns: removed ci's stale waiting marker: not rewritten for 31 minutes");
const dead = spawnSync('node', ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
marker('ci', ci(minsAgo(1), { pid: Number(dead) }));
r = M.readTurns({ dir: DIR, now: NOW });
t('AC6: a CI marker whose VM process has gone is removed', r.removed[0], `memory turns: removed ci's stale waiting marker: the VM process it was written for (pid ${dead}) no longer runs`);
marker('autopilot-gone', ap(minsAgo(1), { queue: join(T, 'other-queue.json') }));
r = M.readTurns({ dir: DIR, now: NOW });
t('AC6: an autopilot marker whose batch has no live pass is removed', r.removed[0], "memory turns: removed autopilot-gone's stale waiting marker: the batch that wrote it has no live pass");
writeFileSync(join(DIR, 'junk.json'), '{');
t('an unreadable marker is removed', M.readTurns({ dir: DIR, now: NOW }).removed[0], "memory turns: removed junk's stale waiting marker: it could not be read");
const w1 = M.writeTurn('ci', { side: 'ci', why: 'x', pid: process.pid }, { dir: DIR, now: minsAgo(4) });
const w2 = M.writeTurn('ci', { side: 'ci', why: 'y', pid: process.pid }, { dir: DIR, now: NOW, live: [w1] });
t('a rewrite keeps the time the wait began', w2.since, minsAgo(4));
t('a rewrite refreshes it', JSON.parse(readFileSync(join(DIR, 'ci.json'), 'utf8')).at, NOW);
t('clearTurn removes the marker', M.clearTurn('ci', { dir: DIR }) && !existsSync(join(DIR, 'ci.json')), true);

// ---- the CLI, as desk-runner calls it (AC1, AC3)
const cli = (args, extra = {}) => spawnSync('node', [join(BIN, 'mem-turns.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...extra } });
const turnsDir = join(env.DESK_HOME, 'memory-turns');
// A pid that outlives this suite's checks, for the marker the CLI writes.
const vm = spawn('sleep', ['30']);
let c = cli(['ci', '--slot-gb', '7', '--running', '0', '--pid', String(vm.pid)], { DESK_MEM_AVAIL_GB: '12', DESK_RUNNER_RESIDENT_GB: '3' });
t('AC1 CLI: exits 1 to wait', c.status, 1);
t('AC1 CLI: says why', c.stdout.trim(), 'a slot waits for memory: 12.0G available, a slot claims 6.0G (1 x 7 + 2 for the VM - 3.0 it holds), which would leave 6.0G, under the 8G floor');
t('AC1 CLI: keeps CI\'s marker', JSON.parse(readFileSync(join(turnsDir, 'ci.json'), 'utf8')).pid, vm.pid);
c = cli(['status'], { DESK_MEM_AVAIL_GB: '12' });
t('AC1 status: says the slot is waiting for memory', /^memory: a CI slot waiting for memory since \d\d:\d\d: 12\.0G available/m.test(c.stdout), true);
c = cli(['ci', '--slot-gb', '7', '--running', '0', '--pid', String(vm.pid)], { DESK_MEM_AVAIL_GB: '20', DESK_RUNNER_RESIDENT_GB: '3' });
t('a claim the floor allows: exits 0', c.status, 0);
t('and CI\'s marker goes', existsSync(join(turnsDir, 'ci.json')), false);
mkdirSync(turnsDir, { recursive: true });
writeFileSync(join(turnsDir, 'autopilot-r.json'), JSON.stringify(ap(minsAgo(5))));
c = cli(['ci', '--slot-gb', '7', '--running', '1', '--pid', String(vm.pid)], { DESK_MEM_AVAIL_GB: '30', DESK_RUNNER_RESIDENT_GB: '9' });
t('AC3 CLI: a waiting batch holds the next slot', c.status, 1);
t('AC3 status: says autopilot is waiting', /^memory: autopilot \(r\) waiting for memory since/m.test(cli(['status'], { DESK_MEM_AVAIL_GB: '30' }).stdout), true);
cli(['ci', 'clear']);
t('ci clear removes CI\'s marker', existsSync(join(turnsDir, 'ci.json')), false);
t('a bad call is refused', cli(['ci', '--running', '1']).status, 2);
vm.kill();

console.log(fails ? `\n${fails} FAILED` : '\nall memory-turn checks passed');
process.exit(fails ? 1 : 0);
