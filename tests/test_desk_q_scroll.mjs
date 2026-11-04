// suite: desk-q scrolling (what one wheel notch, one input read and one refresh start and read)
// covers: desk/bin/desk-q.mjs desk/bin/needs-you.mjs desk/bin/batches.mjs desk/bin/queue.mjs desk/bin/batch-state.mjs
// The real interactive() on injected input and output, against fixture repos under a throwaway HOME,
// DESK_HOME and DESK_CONFIG_ROOT. It counts subprocess starts and file reads, never milliseconds, so it
// holds on a loaded machine.
import cp from 'node:child_process';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const NOW = Date.now();
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const T = mkdtempSync(join(tmpdir(), 'desk-q-scroll-'));
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

const queuePath = (slug, batch) => join(env.DESK_HOME, 'repos', slug, ...(batch ? ['batches', batch] : []), 'queue.json');
const writeQueue = (slug, batch, q) => {
  const p = queuePath(slug, batch);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof q === 'string' ? q : JSON.stringify({ version: 1, batch: batch ?? slug, concurrency: 2, ...q, tickets: Object.fromEntries(Object.entries(q.tickets).map(([k, v]) => [k, { key: k, added_at: minsAgo(600), ...v }])) }));
};
// One repo's config and standing queue. `root: false` is a config naming no checkout.
function put(name, port, tickets, { root = true } = {}) {
  const slug = `acme__${name}`;
  const dir = join(T, 'repos', name);
  mkdirSync(dir, { recursive: true });
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`]);
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    (root ? `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${dir}\` |\n\n` : '') +
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${port}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`2 / 3\` |\n`);
  writeQueue(slug, null, { tickets });
  const triage = join(env.HOME, '.desk-autopilot', slug, 'triage');
  mkdirSync(triage, { recursive: true });
  for (const k of Object.keys(tickets)) writeFileSync(join(triage, `${k}.json`), JSON.stringify({ ticket: k, epic: null, lane: 'A', size: 'S', summary: `${k} a title long enough that a narrow terminal has to cut it short` }));
  mkdirSync(join(env.HOME, '.desk-autopilot', slug, 'orchestrators'), { recursive: true });
  writeFileSync(join(env.HOME, '.desk-autopilot', slug, 'orchestrators', 'q.json'), JSON.stringify({ queue: queuePath(slug), batch: slug, pid: 1, at: minsAgo(1) }));
  return slug;
}
const parked = (q) => ({ state: 'parked', lane: 'A', park: { question: q, since: minsAgo(30) } });
const two = (n) => String(n).padStart(2, '0');
const many = (prefix, n, v) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}-${two(i + 1)}`, v(i)]));

const OMEGA = put('omega', 3900, { ...many('P', 4, () => parked('which copy?')), ...many('R', 6, () => ({ state: 'triaged', lane: 'A', open_questions: 0 })) });
writeQueue(OMEGA, 'F-1', { base: 'feat/f', tickets: { 'F-2': { state: 'running', lane: 'A' } } });
const LONG = put('long', 4000, many('L', 45, () => ({ state: 'triaged', lane: 'A', open_questions: 0 })));

// Every subprocess start and every read of a file under the fixture, since the last reset.
const seen = { spawns: [], reads: [] };
const reset = () => { seen.spawns = []; seen.reads = []; };
for (const f of ['execFileSync', 'spawnSync', 'execSync', 'spawn', 'exec', 'execFile', 'fork']) {
  const real = cp[f];
  cp[f] = function counted(...a) { seen.spawns.push([a[0], ...(Array.isArray(a[1]) ? a[1] : [])].join(' ')); return real.apply(this, a); };
}
const realRead = fs.readFileSync;
fs.readFileSync = function counted(p, ...a) { if (String(p).startsWith(T)) seen.reads.push(String(p)); return realRead.call(this, p, ...a); };
syncBuiltinESMExports();

const Q = await import(join(BIN, 'desk-q.mjs'));
const N = await import(join(BIN, 'needs-you.mjs'));
const B = await import(join(BIN, 'batches.mjs'));

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const screens = [];
function screen(start, { columns = 100, rows = 24, refreshMs = 600000 } = {}) {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = { buf: '', columns, rows, write(s) { this.buf += s; }, on(e, f) { if (e === 'resize') this.resize = f; }, removeListener() {} };
  const ui = Q.interactive({ input, output, start, exit() {}, opener() {}, refreshMs, probeMs: 600000, clock: () => NOW, probeWith: async () => ({ ran: false }), costWith: () => ({ started: false }) });
  screens.push(ui);
  const frame = () => output.buf.split('\x1b[H').at(-1).replace(ANSI, '').split('\r\n');
  return { input, output, frame,
    frames: () => output.buf.split('\x1b[H').length - 1,
    selected: () => frame().find((l) => /^›/.test(l)) ?? '',
    selectedKey: () => /[A-Z]-\d+/.exec(frame().find((l) => /^›/.test(l)) ?? '')?.[0] ?? null,
    send: async (s) => { input.write(s); await sleep(20); } };
}
const WHEEL_DOWN = '\x1b[<65;5;5M';
// What one input read started and read, and the frames it wrote.
async function notch(s, data = WHEEL_DOWN) {
  const was = s.frames();
  reset();
  await s.send(data);
  return { spawns: seen.spawns.length, reads: seen.reads.length, frames: s.frames() - was };
}

// ---- The counters count: without this, every zero below could be a counter that never fires.
reset();
Q.queueRun({ queuePath: queuePath(OMEGA), stateDir: join(env.HOME, '.desk-autopilot', OMEGA) }, ['--help']);
t('the subprocess counter sees a queue.mjs run', seen.spawns.length, 1);

// ---- AC1, AC2: a Queue with parked tickets
const q = screen({ kind: 'repo', slug: OMEGA });
await sleep(20);
// The selectable rows in the order drawn: the running ticket in the other batch, then this batch's.
const order = q.frame().flatMap((x) => /^[› ]\s.*?\b([A-Z]-\d+)\b/.exec(x)?.[1] ?? []);
const q0 = q.selectedKey();
t('the parked tickets are on the screen', order.includes('P-01'), true);
reset();
q.output.resize();
t('the read counter sees a rebuild read the queue fixtures', seen.reads.length > 0, true);
const q1 = await notch(q);
t('AC1 a wheel notch moves the selection one row', q.selectedKey(), order[order.indexOf(q0) + 1]);
t('AC1 and starts no subprocess', q1.spawns, 0);
t('AC2 and reads no queue, triage or config file', q1.reads, 0);
t('a wheel notch writes one frame', q1.frames, 1);
const up = await notch(q, '\x1b[<64;5;5M');
t('a wheel notch up moves back, starting and reading nothing', `${q.selectedKey()} ${up.spawns} ${up.reads}`, `${q0} 0 0`);
const arrow = await notch(q, '\x1b[B');
t('an arrow key moves as the wheel does, starting and reading nothing', `${q.selectedKey()} ${arrow.spawns} ${arrow.reads}`, `${order[order.indexOf(q0) + 1]} 0 0`);
const typed = await notch(q, ':');
const typed2 = await notch(q, 'x');
t('typing a command starts and reads nothing', `${typed.spawns + typed2.spawns} ${typed.reads + typed2.reads} ${q.frame().at(-1)}`, '0 0 :x');
await q.send('\x1b');
await sleep(600);

// ---- AC3: its Timeline, By day and Epics
for (const [key, name] of [['2', 'Timeline'], ['3', 'By day'], ['4', 'Epics']]) {
  const v = screen({ kind: 'repo', slug: OMEGA });
  await sleep(20);
  await v.send(key);
  const n = await notch(v);
  t(`AC3 a wheel notch on ${name} starts and reads nothing`, `${n.spawns} ${n.reads}`, '0 0');
}

// ---- AC4: home with a repo whose tickets are parked
const h = screen({ kind: 'overview', all: false });
await sleep(20);
const hn = await notch(h);
t('AC4 a wheel notch on home starts and reads nothing', `${hn.spawns} ${hn.reads}`, '0 0');

// ---- AC5: 30 wheel reports in one read
const l = screen({ kind: 'repo', slug: LONG });
await sleep(20);
const l0 = l.selectedKey();
const l30 = await notch(l, WHEEL_DOWN.repeat(30));
t('AC5 30 wheel reports in one read: the selection ends 30 rows on', `${l0} ${l.selectedKey()}`, 'L-01 L-31');
t('AC5 and one frame is written', l30.frames, 1);
t('AC5 and nothing is started or read', `${l30.spawns} ${l30.reads}`, '0 0');
const k30 = await notch(l, '\x1b[A'.repeat(30));
t('30 arrow keys in one read move as far and write one frame', `${l.selectedKey()} ${k30.frames}`, 'L-01 1');
const open = await notch(l, `${'\x1b[B'.repeat(2)}\r`);
t('a read that opens a ticket writes one frame, of the ticket it selected', `${open.frames} ${l.frame()[0].includes('L-03')}`, '1 true');

// ---- AC8: a resize redraws the rows to the new width
const rz = screen({ kind: 'repo', slug: LONG }, { columns: 120 });
await sleep(20);
const rowOf = (s) => s.frame().find((x) => x.includes('L-02')) ?? '';
const wide = rowOf(rz).length;
rz.output.columns = 60;
rz.output.resize();
t('AC8 the rows are redrawn to the new width', `${wide > 60} ${rowOf(rz).length <= 60} ${rowOf(rz).endsWith('…')}`, 'true true true');

// ---- AC9: t moves the selected ticket, shown on the next frame
const mv = screen({ kind: 'repo', slug: LONG });
await sleep(20);
await mv.send('\x1b[B\x1b[B\x1b[B');
t('AC9 the fourth ticket is selected', mv.selectedKey(), 'L-04');
const was9 = mv.frames();
await mv.send('t');
const rows9 = mv.frame().filter((x) => /\bL-\d\d\b/.test(x)).map((x) => /L-\d\d/.exec(x)[0]);
t('AC9 the moved order shows on the next frame, the same ticket selected', `${rows9.slice(0, 2).join()} ${mv.selectedKey()} ${mv.frames() - was9}`, 'L-04,L-01 L-04 1');

// ---- AC6, AC7: the 2-second refresh
const SLUG7 = put('sigma', 4100, { ...many('S', 3, () => parked('which copy?')) });
writeQueue(SLUG7, 'G-1', { tickets: { 'G-2': { state: 'done', result: { pr: 7 } } } });
writeQueue(SLUG7, 'G-3', { tickets: { 'G-4': { state: 'done', result: { pr: 8 }, pr_status: { state: 'MERGED' } } } });
const rf = screen({ kind: 'repo', slug: SLUG7 }, { refreshMs: 40 });
await sleep(20);
await rf.send('\x1b[B');
const sel7 = rf.selectedKey();
reset();
const before = rf.frames();
await sleep(200);
t('AC6 the refresh ran', rf.frames() > before, true);
t('AC6 and started no subprocess to list the batches, nor asked GitHub of a done one', seen.spawns.filter((s) => /queue\.mjs|^gh\b/.test(s)).length, 0);
const q7 = JSON.parse(readFileSync(queuePath(SLUG7), 'utf8'));
q7.tickets[sel7] = { ...q7.tickets[sel7], state: 'triaged', park: null, open_questions: 0 };
writeFileSync(queuePath(SLUG7), JSON.stringify(q7));
await sleep(200);
t('AC7 the next refresh shows the new state, the selection on the same ticket', `${rf.selectedKey()} ${rf.selected().includes('which copy?')} ${rf.frame().some((x) => /^Ready|^ *Ready/.test(x))}`, `${sel7} false true`);

// ---- finished on the queue's record: asks GitHub nothing
t('a done batch with a PR the queue records as merged is finished', B.finishedOnRecord({ tickets: { a: { state: 'done', result: { pr: 1 }, pr_status: { state: 'MERGED' } } } }), true);
t('a PR recorded closed, or merged_at set, counts as shut', B.finishedOnRecord({ tickets: { a: { state: 'done', result: { pr: 1 }, pr_status: { state: 'CLOSED' } }, b: { state: 'done', result: { pr: 2 }, merged_at: minsAgo(1) } } }), true);
t('a PR the queue does not record as shut counts as open', B.finishedOnRecord({ tickets: { a: { state: 'done', result: { pr: 1 } } } }), false);
t('a batch on a base is never finished', B.finishedOnRecord({ base: 'feat/x', tickets: { a: { state: 'done' } } }), false);
const rSigma = () => Q.loadRepos(NOW).find((r) => r.id === SLUG7);
reset();
t('the batches offered: the one with a PR still open, not the one merged', JSON.stringify(N.moveTargets(rSigma())), JSON.stringify([{ name: 'G-1', base: 'main', word: 'G-1' }]));
t('and listing them asks GitHub nothing', seen.spawns.filter((s) => /^gh\b|queue\.mjs/.test(s)).length, 0);

// ---- AC11: /desk-needs-you offers the move, in the same words
const listed = N.listText(N.collect({ word: 'omega', now: NOW })).split('\n').find((x) => x.startsWith('omega P-01 parked')) ?? '';
t('AC11 its item offers the move to the other batch, with the same text', listed.includes('move (move <batch> takes it out of this batch and queues it in another, its next worker on that base: F-1 (on feat/f))'), true);
const qr = JSON.parse(Q.queueRun({ queuePath: queuePath(OMEGA), stateDir: join(env.HOME, '.desk-autopilot', OMEGA) }, ['running'], Q.checkoutOf({ slug: OMEGA, name: 'omega' }, 'x')).out);
t('AC11 queue.mjs running still lists what the shared logic does', JSON.stringify(qr), JSON.stringify([{ name: 'F-1', base: 'feat/f' }]));

// ---- AC10: a ticket put off with no move action comes back when a second batch starts
const TAU = put('tau', 4200, { 'T-1': parked('which copy?') });
const rTau = () => Q.loadRepos(NOW).find((r) => r.id === TAU);
t('AC10 parked, with no other batch running, it offers no move', N.collect({ word: 'tau', now: NOW }).items[0].actions.some(([a]) => a === 'move'), false);
const off = N.record({ word: 'tau', ticket: 'T-1', action: 'not-now', now: NOW });
t('AC10 put off, it no longer counts', `${off.ok} ${N.needsCount(rTau()).shown} ${N.needsCount(rTau()).putOff}`, 'true 0 1');
writeQueue(TAU, 'H-1', { base: 'feat/h', tickets: { 'H-2': { state: 'running', lane: 'A' } } });
t('AC10 a second batch running: it counts in Needs you again by the next refresh', `${N.needsCount(rTau()).shown} ${N.needsCount(rTau()).putOff}`, '1 0');

// ---- AC12: the batch list cannot be read
const NOROOT = put('upsilon', 4300, { 'U-1': parked('which copy?') }, { root: false });
writeQueue(NOROOT, 'V-1', { base: 'feat/v', tickets: { 'V-2': { state: 'running', lane: 'A' } } });
const BROKEN = put('phi', 4400, { 'W-1': parked('which copy?') });
writeQueue(BROKEN, 'X-1', '{ not json');
for (const [slug, word, key] of [[NOROOT, 'upsilon', 'U-1'], [BROKEN, 'phi', 'W-1']]) {
  const s = screen({ kind: 'repo', slug });
  await sleep(20);
  t(`AC12 ${word}: the screen still draws its ticket`, s.frame().some((x) => x.includes(key)) && !s.frame().some((x) => x.startsWith('Could not draw')), true);
  const r = Q.loadRepos(NOW).find((x) => x.id === slug);
  t(`AC12 ${word}: and offers no move action`, `${N.moveTargets(r).length} ${N.collect({ word, now: NOW }).items.find((i) => i.t.key === key)?.actions.some(([a]) => a === 'move')}`, '0 false');
}

for (const ui of screens) ui.finish(0);
console.log(fails ? `${fails} FAILED` : 'all desk-q scrolling checks passed');
process.exit(fails ? 1 : 0);
