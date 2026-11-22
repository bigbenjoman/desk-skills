// suite: desk-q Home's hidden warnings (h and H)
// layer: L2
// Home's ▲ notes hidden with h and shown with H, against fixture repos under a throwaway HOME,
// DESK_HOME and DESK_CONFIG_ROOT, with a fake launchctl. The hidden list is the throwaway HOME's
// .desk-autopilot/machine/hidden-warnings.json. Nothing touches your real state.
import { mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-q.mjs');
const T = scratch('desk-q-hide-');
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
mkdirSync(join(T, 'bin'));
writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills'), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
mkdirSync(join(env.DESK_SKILLS_DIR, 'desk-needs-you'), { recursive: true });
writeFileSync(join(env.DESK_SKILLS_DIR, 'desk-needs-you', 'SKILL.md'), '# desk-needs-you\n');

const state = (name, batch) => join(env.HOME, '.desk-autopilot', `acme__${name}`, ...(batch ? ['batches', batch] : []));
// A supervised repo, its standing batch and `batches` beside it, each live with one ticket running.
function repo(name, port, { batches = [], tickets } = {}) {
  const slug = `acme__${name}`;
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${port}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`2 / 3\` |\n| Batches run by | \`supervisor\` | \`supervisor\` |\n`);
  for (const b of [null, ...batches]) {
    const q = join(env.DESK_HOME, 'repos', slug, ...(b ? ['batches', b] : []), 'queue.json');
    mkdirSync(dirname(q), { recursive: true });
    const tk = tickets ?? { [`${(b ?? name).toUpperCase()}-1`]: { state: 'running', stage: '3/9' } };
    writeFileSync(q, JSON.stringify({ version: 1, batch: b ?? name, concurrency: 2, supervised: true, tickets: Object.fromEntries(Object.entries(tk).map(([k, v]) => [k, { key: k, ...v }])) }));
    mkdirSync(join(state(name, b), 'orchestrators'), { recursive: true });
    writeFileSync(join(state(name, b), 'orchestrators', 'q.json'), JSON.stringify({ queue: q, batch: b ?? name, pid: 1, at: minsAgo(1) }));
  }
}
// The batch's merge driver stopped, failing with `reason`, its log last written at `at`.
function stopped(name, batch, reason, at = new Date()) {
  writeFileSync(join(state(name, batch), 'supervisor.json'), JSON.stringify({ driver: { pid: null, started: minsAgo(20), from: 0, failures: 1, notified: false, code: 1, reason: `FAIL: ${reason}` } }));
  writeFileSync(join(state(name, batch), 'merge-driver.log'), `FAIL: ${reason}\nmerge driver exited 1\n`);
  utimesSync(join(state(name, batch), 'merge-driver.log'), at, at);
}

// alpha: two live batches, the repo's merge driver stopped; pn shares ports with alpha and has a
// ticket that needs you; beta and gamma share ports.
repo('alpha', 5100, { batches: ['feat'] });
stopped('alpha', null, 'gh is signed out');
stopped('alpha', 'feat', 'gh is signed out');
repo('pn', 5102, { tickets: { 'PN-1': { state: 'parked', park: { question: 'which copy?' } } } });
repo('beta', 5200);
repo('gamma', 5201);

Object.assign(process.env, env);
const Q = await import(BIN);
const HIDDEN = join(env.HOME, '.desk-autopilot', 'machine', 'hidden-warnings.json');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// Home in a fresh desk-q, as each open of it is: `press` a key, `frame` the screen's lines, `close` quits.
async function open() {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {} });
  const output = { buf: '', columns: 200, rows: 80, write(s) { this.buf += s; }, on() {}, removeListener() {} };
  const ui = Q.interactive({ input, output, start: { kind: 'overview', all: false }, exit: () => {}, refreshMs: 600000, probeWith: async () => ({ ran: false }) });
  const frame = () => output.buf.split('\x1b[H').at(-1).split('\r\n').map((l) => l.replace(/\x1b\[J$/, '').replace(/\x1b\[K$/, '').replace(ANSI, ''));
  const press = async (s) => { input.write(s); await sleep(40); };
  await sleep(40);
  return { press, frame, close: () => ui.finish(0) };
}
const NOTE = /^(note| {4}) {2}/;
const notes = (f) => f.filter((l) => NOTE.test(l)).map((l) => l.replace(NOTE, '').trimEnd());
const warns = (f) => notes(f).filter((l) => l.startsWith('▲'));
const summary = (f) => notes(f).filter((l) => / hidden · H shows them$/.test(l));

// ---- AC10 and AC11, before anything is hidden.
let s = await open();
const before = warns(s.frame());
t('AC10 the repo with two live batches shows its stopped merge driver once',
  before.filter((l) => /^▲ alpha +the merge driver stopped at \d\d:\d\d: gh is signed out\. Run gh auth login\.$/.test(l)).length, 1);
t('three ▲ warnings to start: the merge driver and the two port clashes',
  `${before.length} ${before.filter((l) => l.startsWith('▲ ports')).length}`, '3 2');
t('AC11 the key help names h and H', s.frame().some((l) => /(^|· )h hide warnings · H show hidden warnings( ·|$)/.test(l)), true);

// ---- AC1 and AC7: h hides the three, the ◆ needs you note stays.
await s.press('h');
let f = s.frame();
t('AC1 h takes the three warnings off Home', warns(f).length, 0);
t('AC1 one grey line reads that three are hidden', f.filter((l) => l === 'note  3 warnings hidden · H shows them').length, 1);
t('AC7 the ◆ needs you note stays on screen', notes(f).some((l) => l.startsWith('◆ needs you')), true);
t('the hidden list is saved', Object.keys(JSON.parse(readFileSync(HIDDEN, 'utf8')).hidden).length, 3);

// ---- AC9: nothing left to hide.
await s.press('h');
t('AC9 h with no ▲ warning on Home says there are none to hide', s.frame().includes('No warnings to hide.'), true);
t('AC9 and nothing else changes', `${warns(s.frame()).length} ${summary(s.frame()).length}`, '0 1');

// ---- AC8: quit and open again.
s.close();
s = await open();
t('AC8 the same warnings are still hidden after desk-q opens again', `${warns(s.frame()).length} ${summary(s.frame())[0]}`, '0 3 warnings hidden · H shows them');

// ---- AC6: the clock time in the merge driver's note moves on.
const later = new Date(Date.now() - 97 * 60000);
utimesSync(join(state('alpha'), 'merge-driver.log'), later, later);
utimesSync(join(state('alpha', 'feat'), 'merge-driver.log'), later, later);
s.close();
s = await open();
t('AC6 a warning whose clock time moved on stays hidden', `${warns(s.frame()).length} ${summary(s.frame()).length}`, '0 1');
const amount = (usd, at) => ({ tag: '▲ credits', text: [[`AWS credits are covering ${usd} of use, at ${at}.`, null]] });
t('AC6 a dollar amount or a time that moves on keeps the note\'s key', Q.noteKey(amount('$12.50', '14:02')) === Q.noteKey(amount('$1,013.07', '15:10')), true);
t('AC6 a duration that moves on keeps the note\'s key', Q.noteKey({ tag: '▲ x', text: [['nothing started for 59m.', null]] }) === Q.noteKey({ tag: '▲ x', text: [['nothing started for 2h 5m.', null]] }), true);

// ---- AC3: the merge driver's wording changes.
stopped('alpha', null, 'no PR for AL-1');
stopped('alpha', 'feat', 'no PR for AL-1');
s.close();
s = await open();
f = s.frame();
t('AC3 a hidden warning whose wording changed shows again', warns(f).filter((l) => /^▲ alpha +the merge driver stopped at \d\d:\d\d: no PR for AL-1\.$/.test(l)).length, 1);
t('AC3 and the hidden count drops by one', summary(f)[0], '2 warnings hidden · H shows them');

// ---- AC4: a new warning appears.
repo('delta', 5400);
repo('epsilon', 5402);
s.close();
s = await open();
f = s.frame();
t('AC4 a new warning shows', warns(f).some((l) => /^▲ ports +delta \+ epsilon share /.test(l)), true);
t('AC4 and the hidden ones stay hidden', `${warns(f).filter((l) => /beta \+ gamma/.test(l)).length} ${summary(f)[0]}`, '0 2 warnings hidden · H shows them');

// ---- AC5: hidden 24 hours ago and still true.
const file = JSON.parse(readFileSync(HIDDEN, 'utf8'));
for (const k of Object.keys(file.hidden)) file.hidden[k] = new Date(Date.now() - Q.HIDE_MS).toISOString();
writeFileSync(HIDDEN, JSON.stringify(file));
await s.press('a'); await s.press('a');
f = s.frame();
t('AC5 a warning hidden 24 hours ago shows again on the next redraw', `${warns(f).filter((l) => /beta \+ gamma/.test(l)).length} ${summary(f).length}`, '1 0');

// ---- AC2: H shows every hidden warning again.
await s.press('h');
t('h hides every warning on Home', `${warns(s.frame()).length} ${summary(s.frame())[0]}`, '0 4 warnings hidden · H shows them');
await s.press('H');
f = s.frame();
t('AC2 H shows all of them again and the summary line goes', `${warns(f).length} ${summary(f).length}`, '4 0');
await s.press('H');
t('H with nothing hidden says so', s.frame().includes('No warnings are hidden.'), true);
s.close();

console.log(fails ? `${fails} failed` : 'all desk-q hidden warnings checks passed');
process.exit(fails ? 1 : 0);
