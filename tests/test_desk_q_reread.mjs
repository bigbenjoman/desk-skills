// suite: desk-q rereads on change (an idle open screen rereads no queue and starts no process)
// covers: desk/bin/desk-q.mjs
// The real interactive() on injected input and output and a fake clock, against a fixture repo under a
// throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT. Its batch is handed to the supervisor, so every
// reread runs launchctl once (a fake one on PATH): rereads are counted by those starts and by reads of
// the queue file, never by milliseconds.
import cp from 'node:child_process';
import fs, { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const NOW = Date.now();
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const T = scratch('desk-q-reread-');
mkdirSync(join(T, 'bin'));
writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills'), DESK_LOCK_DIR: join(T, 'locks'), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
for (const k of Object.keys(process.env)) if (k.startsWith('DESK_') || k.startsWith('AUTOPILOT_')) delete process.env[k];
Object.assign(process.env, env);
process.env.NO_COLOR = '1';
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });
mkdirSync(env.DESK_HOME, { recursive: true });
fs.symlinkSync(BIN, join(env.DESK_HOME, 'bin'));
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');

const SLUG = 'acme__rho';
const QUEUE = join(env.DESK_HOME, 'repos', SLUG, 'queue.json');
const STATE = join(env.HOME, '.desk-autopilot', SLUG);
const iso = (ms) => new Date(ms).toISOString();
const writeQueue = (tickets) => writeFileSync(QUEUE, JSON.stringify({ version: 1, batch: SLUG, concurrency: 2, supervised: true,
  tickets: Object.fromEntries(Object.entries(tickets).map(([k, v]) => [k, { key: k, added_at: iso(NOW - 3600000), lane: 'A', ...v }])) }));
const dir = join(T, 'repos', 'rho');
mkdirSync(dir, { recursive: true });
mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', SLUG), { recursive: true });
writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', SLUG, 'config.md'),
  `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${dir}\` |\n\n`
  + '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `4500` |\n| Autopilot worker concurrency | `2 / 3` | `2 / 3` |\n');
mkdirSync(dirname(QUEUE), { recursive: true });
writeQueue({ 'R-1': { state: 'running', stage: '3/9' }, 'R-2': { state: 'triaged', open_questions: 0 } });
for (const sub of ['orchestrators', 'logs']) mkdirSync(join(STATE, sub), { recursive: true });
writeFileSync(join(STATE, 'orchestrators', 'q.json'), JSON.stringify({ queue: QUEUE, batch: SLUG, pid: 1, at: iso(NOW - 60000) }));
const LOG = join(STATE, 'logs', 'R-1.log');
writeFileSync(LOG, 'AUTOPILOT_STAGE: 3/9 implement\n');

// Every subprocess start, and every read of the queue file, since the last reset.
const seen = { spawns: [], reads: 0 };
const reset = () => { seen.spawns = []; seen.reads = 0; };
for (const f of ['execFileSync', 'spawnSync', 'execSync', 'spawn', 'exec', 'execFile', 'fork']) {
  const real = cp[f];
  cp[f] = function counted(...a) { seen.spawns.push([a[0], ...(Array.isArray(a[1]) ? a[1] : [])].join(' ')); return real.apply(this, a); };
}
const realRead = fs.readFileSync;
fs.readFileSync = function counted(p, ...a) { if (String(p) === QUEUE) seen.reads++; return realRead.call(this, p, ...a); };
syncBuiltinESMExports();
const rereads = () => seen.spawns.filter((s) => s.startsWith('launchctl')).length;

const Q = await import(join(BIN, 'desk-q.mjs'));

let now = NOW;
const input = new PassThrough();
Object.assign(input, { isTTY: true, setRawMode() {} });
const output = { buf: '', columns: 120, rows: 30, write(s) { this.buf += s; }, on() {}, removeListener() {} };
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const frames = () => output.buf.split('\x1b[H').length - 1;
const frame = () => output.buf.split('\x1b[H').at(-1).replace(ANSI, '').split('\r\n');
const ui = Q.interactive({ input, output, start: { kind: 'repo', slug: SLUG }, exit() {}, opener() {}, refreshMs: 25, probeMs: 600000,
  clock: () => now, probeWith: async () => ({ ran: false }), costWith: () => ({ started: false }) });
await sleep(60);

// ---- The counters count: a reread runs launchctl and reads the queue.
reset();
Q.loadRepos(now);
t('a reread runs launchctl once and reads the queue', `${rereads()} ${seen.reads > 0}`, '1 true');

// ---- AC1: nothing changed, so the timer redraws and rereads nothing
reset();
const f1 = frames();
await sleep(250);
t('AC1 the timer keeps redrawing', frames() - f1 >= 3, true);
t('AC1 and rereads no queue', seen.reads, 0);
t('AC1 and starts no process', seen.spawns.length, 0);

// ---- AC4: a worker writing only to its log brings no reread
reset();
for (let i = 0; i < 5; i++) { appendFileSync(LOG, `working ${i}\n`); await sleep(40); }
t('AC4 a growing worker log rereads no queue and starts no process', `${seen.reads} ${seen.spawns.length}`, '0 0');

// ---- AC2: a pass writing the queue is shown by the next tick
reset();
writeQueue({ 'R-1': { state: 'running', stage: '3/9' }, 'R-2': { state: 'triaged', open_questions: 0 }, 'R-3': { state: 'triaged', open_questions: 0 } });
await sleep(150);
t('AC2 the queue write is shown', frame().some((l) => l.includes('R-3')), true);
t('AC2 by one reread', rereads(), 1);

// ---- AC3: with nothing changed, one reread once 30 seconds have passed since the last
reset();
now += Q.REREAD_MS - 1000;
await sleep(150);
t('AC3 29 seconds on, still no reread', rereads(), 0);
now += 1000;
await sleep(150);
t('AC3 30 seconds on, the queues are reread once', rereads(), 1);

// ---- AC5: a move rereads at once, and the idle ticks after it reread nothing
reset();
input.write('t');
await sleep(20);
t('AC5 a move rereads the queues at once', rereads() >= 1 && seen.reads > 0, true);
reset();
await sleep(150);
t('AC5 and the ticks after it reread nothing', rereads(), 0);

ui.finish(0);
console.log(fails ? `${fails} FAILED` : 'all desk-q reread checks passed');
process.exit(fails ? 1 : 0);
