// suite: desk-q usage line (5-hour and 7-day bars on every header, and the probe that keeps them fresh)
// desk-q against fixture worker logs carrying rate_limit_event lines, a fixed clock, and a fake claude
// that records its environment and arguments, under a throwaway HOME, DESK_HOME, DESK_CONFIG_ROOT,
// DESK_LOCK_DIR and DESK_USAGE_DIR. One check or more per acceptance criterion of DS-220.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rgbOfSgr } from './sgr_rgb.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-q-usage-'));
mkdirSync(join(T, 'bin'));
writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_LOCK_DIR: join(T, 'locks'), DESK_USAGE_DIR: join(T, 'usage'), DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills'), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'COLORFGBG', 'COLORTERM', 'NO_COLOR']) delete process.env[k];
Object.assign(process.env, env);
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');

// One repo's config and queue: `tickets` as { KEY: state }.
function repo(name, tickets, pacing = null) {
  const slug = `acme__${name}`;
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `3100` |\n| Autopilot worker concurrency | `2 / 3` | `2 / 3` |\n'
    + (pacing ? `| Usage pacing headroom (points) | \`5\` | \`${pacing}\` |\n` : ''));
  const q = join(env.DESK_HOME, 'repos', slug, 'queue.json');
  mkdirSync(dirname(q), { recursive: true });
  writeFileSync(q, JSON.stringify({ version: 1, batch: name, concurrency: 2, tickets: Object.fromEntries(Object.entries(tickets).map(([k, s]) => [k, { key: k, state: s }])) }));
}
const unrepo = (name) => { rmSync(join(env.DESK_CONFIG_ROOT, 'repos', `acme__${name}`), { recursive: true, force: true }); rmSync(join(env.DESK_HOME, 'repos', `acme__${name}`), { recursive: true, force: true }); };
repo('solo', { 'S-1': 'triaged' });

// Saturday 24 October 2026, 09:00 local: the 5-hour window resets at 11:20 today, the 7-day one at
// 15:00 tomorrow, when 82% of the week is gone.
const FIXED = new Date(2026, 9, 24, 9, 0).getTime();
const at = (d, h, m) => Math.round(new Date(2026, 9, d, h, m).getTime() / 1000);
const MIN = 60000;
const event = (five, seven) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
  five_hour: { utilization: five[0], resetsAt: five[1] }, seven_day: { utilization: seven[0], resetsAt: seven[1] } } } });
// The one worker log holding a reading, last written `ago` ms before FIXED; any earlier one is removed.
let n = 0;
function reading(five, seven, ago = MIN) {
  const logs = join(env.HOME, '.desk-autopilot', 'acme__solo', 'logs');
  rmSync(logs, { recursive: true, force: true });
  mkdirSync(logs, { recursive: true });
  const path = join(logs, `S-${++n}.log`);
  writeFileSync(path, `{"type":"system"}\n${event(five, seven)}\n`);
  utimesSync(path, (FIXED - ago) / 1000, (FIXED - ago) / 1000);
}

const Q = await import(join(BIN, 'desk-q.mjs'));
const P = await import(join(BIN, 'usage-probe.mjs'));
const { PassThrough } = await import('node:stream');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// The usage line after its "Claude usage" label (DS-215 AC21).
const LABEL = 'Claude usage  ';
const usageAt = (out) => out.split('\n').find((l) => l.startsWith(LABEL))?.slice(LABEL.length) ?? '';
const home = () => usageAt(Q.overview(Q.loadRepos(FIXED), { now: FIXED, avail: 30 }));
// Home listing every repo with a batch: a quiet one has a row only there.
const homeAll = () => usageAt(Q.overview(Q.loadRepos(FIXED), { now: FIXED, avail: 30, all: true }));

// The interactive screen on a fixed clock, its probe recorded rather than run.
function screen(start, { probeMs = 600000 } = {}) {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = { buf: '', columns: 200, rows: 40, write(s) { this.buf += s; }, on() {}, removeListener() {} };
  const probes = [];
  const ui = Q.interactive({ input, output, start, exit() {}, refreshMs: 600000, clock: () => FIXED, probeMs, probeWith: async (o) => { probes.push(o.now); return { ran: true }; } });
  const frame = () => output.buf.split('\x1b[H').at(-1).split('\r\n').map((l) => l.replace(/\x1b\[K$/, ''));
  return { ui, probes, frame };
}

// ---- AC1: the line, as text and as drawn
reading([0.17, at(24, 11, 20)], [0.6, at(25, 15, 0)]);
const LINE = '5h ██········ 17% 11:20 · 7d ██████···· 60% Sun 15:00';
t('AC1 home shows both bars with their reset times', home(), LINE);
const S1 = screen({ kind: 'overview', all: false });
await sleep(20);
const drawn1 = S1.frame().find((l) => l.includes('5h ')) ?? '';
S1.ui.finish(0);
const G = '\x1b[38;5;247m', TRACK = '\x1b[38;5;239m';
t('AC1 on screen each bar is solid, the used part in its colour and the rest in 256-colour 239',
  [`${G}5h \x1b[39m\x1b[38;5;108m██\x1b[39m${TRACK}████████\x1b[39m\x1b[38;5;108m 17%\x1b[39m 11:20`, `${G}7d \x1b[39m\x1b[38;5;180m██████\x1b[39m${TRACK}████\x1b[39m\x1b[38;5;180m 60%\x1b[39m Sun 15:00`]
    .filter((s) => !drawn1.includes(s)).join(' | '), '');

// ---- AC2 to AC4: the colour of a bar and its percentage, by how full it is
const win = (u, h = 11) => ({ utilization: u, resetsAt: at(24, h, 20) });
const colours = (seven, held = false) => {
  const l = Q.usageLine({ reading: { five_hour: win(0.1), seven_day: seven, at: FIXED - MIN }, running: 1, held }, { now: FIXED, solid: true });
  const segs = l.segs.slice(l.segs.findIndex(([s]) => s === '7d '));
  const bar = segs.find(([s, k]) => /^█+$/.test(s) && k !== '38;5;239'), pct = segs.find(([s]) => /^ \d+%$/.test(s));
  return `${bar?.[1]}/${pct?.[1]}`;
};
t('AC2 under 60% the bar and its percentage are green', [0.05, 0.17, 0.59].map((u) => colours(win(u))).join(' '), '38;5;108/38;5;108 38;5;108/38;5;108 38;5;108/38;5;108');
t('AC3 at 60% to 84% they are amber', [0.6, 0.72, 0.84].map((u) => colours(win(u))).join(' '), '38;5;180/38;5;180 38;5;180/38;5;180 38;5;180/38;5;180');
t('AC3 and a 7-day window under 60% while weekly pace holds new workers', colours(win(0.4), true), '38;5;180/38;5;180');
t('AC4 at 85% or over they are red, pace hold or not', [colours(win(0.85)), colours(win(0.88)), colours(win(1)), colours(win(0.9), true)].join(' '), '38;5;210/38;5;210 38;5;210/38;5;210 38;5;210/38;5;210 38;5;210/38;5;210');

// ---- AC5: weekly pace holding new workers ends the line
reading([0.2, at(24, 11, 20)], [0.4, at(30, 15, 0)]);
t('AC5 (DS-215 AC20) ahead of weekly pace, the line ends with the note, naming the repo it holds', homeAll().endsWith('Fri 15:00  ▲ solo ahead of pace: no new workers until it slows'), true);
// DS-215 AC20: pacing is each repo's §3b row. A repo set to off is never held, so home neither
// warns nor ambers the 7-day bar for it, and a held repo off the screen does not warn on another's.
repo('calm', { 'C-1': 'triaged' }, 'off');
const calm = () => Q.loadRepos(FIXED).find((r) => r.name === 'calm');
t('DS-215 AC20 with solo held and calm set to off, home names solo alone, and not while solo has no row; calm\'s own screen does not warn',
  `${homeAll().endsWith('▲ solo ahead of pace: no new workers until it slows')} ${!home().includes('ahead of pace')} ${Q.usageOf(Q.loadRepos(FIXED), FIXED, [calm()]).held} ${Q.repoScreen(calm(), { now: FIXED, usage: Q.usageOf(Q.loadRepos(FIXED), FIXED, [calm()]) }).includes('ahead of pace')}`,
  'true true false false');
unrepo('solo'); repo('solo', { 'S-1': 'triaged' }, 'off');
reading([0.2, at(24, 11, 20)], [0.4, at(30, 15, 0)]);
const offSegs = Q.usageLine(Q.usageOf(Q.loadRepos(FIXED), FIXED), { now: FIXED, solid: true }).segs;
t('DS-215 AC20 every repo on home set to off: no note, and the 7-day bar at 40% stays green',
  `${homeAll().includes('ahead of pace')} ${offSegs.slice(offSegs.findIndex(([x]) => x === '7d ')).find(([x]) => /^ \d+%$/.test(x))?.[1]}`, 'false 38;5;108');
unrepo('calm'); unrepo('solo'); repo('solo', { 'S-1': 'triaged' });
reading([0.2, at(24, 11, 20)], [0.4, at(30, 15, 0)]);
t('AC3 and the 7-day bar is amber at 40%', colours(win(0.4), true), '38;5;180/38;5;180');
// The hold is a pass's, which reads the probe's output as well as worker logs (DS-342 AC4): the same
// reading from a probe alone holds too.
rmSync(join(env.HOME, '.desk-autopilot', 'acme__solo', 'logs'), { recursive: true, force: true });
mkdirSync(env.DESK_USAGE_DIR, { recursive: true });
writeFileSync(P.probeLog(), `${event([0.2, at(24, 11, 20)], [0.4, at(30, 15, 0)])}\n`);
utimesSync(P.probeLog(), (FIXED - MIN) / 1000, (FIXED - MIN) / 1000);
t('AC5 (DS-342 AC4) a probe reading ahead of pace, with no worker log, holds as a pass would', homeAll().endsWith('▲ solo ahead of pace: no new workers until it slows'), true);
rmSync(env.DESK_USAGE_DIR, { recursive: true, force: true });

// ---- AC6: a window whose reset time has passed reads 0% with no call
reading([0.7, at(24, 8, 20)], [0.6, at(25, 15, 0)]);
t('AC6 a passed reset reads 0% and when it reset', home().startsWith('5h ·········· 0% · reset 08:20 · 7d ██████···· 60% Sun 15:00'), true);
const S6 = screen({ kind: 'overview', all: false }, { probeMs: 20 });
await sleep(120);
S6.ui.finish(0);
t('AC6 and draws it with no probe, the reading being fresh', S6.probes.length, 0);

// ---- AC7: no worker running and a reading over 5 minutes old: the open screen probes
reading([0.17, at(24, 11, 20)], [0.6, at(25, 15, 0)], 6 * MIN);
const S7 = screen({ kind: 'overview', all: false }, { probeMs: 20 });
await sleep(120);
S7.ui.finish(0);
t('AC7 with no worker running and the reading 6 minutes old, each interval probes', S7.probes.length > 0, true);
const fake = join(T, 'bin', 'claude');
writeFileSync(fake, `#!/bin/sh\nprintf '%s|%s\\n' "\${ANTHROPIC_API_KEY-unset}" "$*" >> "${join(T, 'calls')}"\n`
  + `echo '{"type":"system"}'\necho '${event([0.23, Math.round(Date.now() / 1000) + 3600], [0.45, Math.round(Date.now() / 1000) + 86400])}'\n`, { mode: 0o755 });
// The probe's child is unref'd, so the test holds the event loop open until it reports back.
const run = (now) => new Promise((res) => {
  const hold = setInterval(() => {}, 100);
  const end = (v) => { clearInterval(hold); res(v); };
  P.probe({ claude: fake, env: { ...process.env, ANTHROPIC_API_KEY: 'not-a-real-key' }, now, done: () => end(true) })
    .then((r) => { if (!r.ran) end(r.why); });
});
const real = Date.now();
t('AC7 the probe runs', await run(real), true);
const got = P.readUsage({ dirs: [], now: Date.now() });
t('AC7 and both windows are read from it', `${got.five_hour?.utilization} ${got.seven_day?.utilization}`, '0.23 0.45');
const calls = () => readFileSync(join(T, 'calls'), 'utf8').trim().split('\n');
t('AC7 as one Haiku call', calls()[0].split('|')[1].startsWith('-p Reply with: ok --model haiku --output-format stream-json'), true);

// ---- AC8: a worker running anywhere, or desk-q not open: no probe
// The probe's real-time reading is gone and the fixture's is stale, so only the running worker stops one.
rmSync(env.DESK_USAGE_DIR, { recursive: true, force: true });
reading([0.17, at(24, 11, 20)], [0.6, at(25, 15, 0)], 6 * MIN);
repo('busy', { 'B-1': 'running' });
const S8 = screen({ kind: 'overview', all: false }, { probeMs: 20 });
await sleep(120);
S8.ui.finish(0);
t('AC8 with a worker running, no probe runs', S8.probes.length, 0);
unrepo('busy');
const before8 = calls().length;
Q.run(['--plain'], { now: FIXED });
Q.run(['--plain', 'solo'], { now: FIXED });
await sleep(300);
t('AC8 desk-q printed rather than open runs none', `${existsSync(join(env.DESK_USAGE_DIR, 'probe.at'))} ${calls().length - before8}`, 'false 0');

// ---- AC9: never billed to an API key
t('AC9 the probe runs with ANTHROPIC_API_KEY unset', calls()[0].split('|')[0], 'unset');
t('AC9 its environment is the caller\'s less that key', JSON.stringify([P.probeEnv({ A: '1', ANTHROPIC_API_KEY: 'k' })]), '[{"A":"1"}]');

// ---- AC10: two windows reaching a probe together start one, and none starts within the minute
rmSync(env.DESK_USAGE_DIR, { recursive: true, force: true });
const before = calls().length;
const both = await Promise.all([P.probe({ claude: fake, now: real, done() {} }), P.probe({ claude: fake, now: real, done() {} })]);
t('AC10 two at once: one runs', both.filter((r) => r.ran).length, 1);
t('AC10 another 30 seconds later does not', (await P.probe({ claude: fake, now: real + 30000, done() {} })).ran, false);
mkdirSync(join(env.DESK_LOCK_DIR, 'desk-usage-probe.lock.d'));
writeFileSync(join(env.DESK_LOCK_DIR, 'desk-usage-probe.lock.d', 'pid'), String(process.pid));
t('AC10 nor one while another holds the lock', (await P.probe({ claude: fake, now: real + 120000, done() {} })).ran, false);
rmSync(join(env.DESK_LOCK_DIR, 'desk-usage-probe.lock.d'), { recursive: true, force: true });
t('AC10 a minute on, one does', await run(real + 61000), true);
await sleep(300);
t('AC10 so the fake ran twice in all', calls().length - before, 2);
// The probe's reading is real-time, newer than any fixture: the checks below read the fixtures alone.
rmSync(env.DESK_USAGE_DIR, { recursive: true, force: true });

// ---- AC11: an old reading with no worker running carries its time, in grey
reading([0.17, at(24, 11, 20)], [0.6, at(25, 15, 0)], 6 * MIN);
t('AC11 a reading 6 minutes old with no worker running ends "as of" its time', home(), `${LINE}  as of 08:54`);
const old = Q.usageLine({ reading: P.readUsage({ now: FIXED }), running: 0, held: false }, { now: FIXED });
t('AC11 in grey', JSON.stringify(old.segs.at(-1)), JSON.stringify(['  as of 08:54', '38;5;247']));
repo('busy', { 'B-1': 'running' });
t('AC11 with a worker running it carries none', home(), LINE);
unrepo('busy');
reading([0.17, at(24, 11, 20)], [0.6, at(25, 15, 0)], 4 * MIN);
t('AC11 nor under 5 minutes old', home(), LINE);

// ---- AC12: the repo screen's header carries the same line
const repoOut = Q.run(['--plain', 'solo'], { now: FIXED });
t('AC12 the repo screen carries the same usage line as home', usageAt(repoOut), home());
t('AC12 under its pass line', repoOut.split('\n').findIndex((l) => l.startsWith(LABEL)) > repoOut.split('\n').findIndex((l) => /last pass|no pass yet|stopped/.test(l)), true);
const S12 = screen({ kind: 'repo', slug: 'acme__solo' });
await sleep(20);
S12.ui.finish(0);
t('AC12 and so does the repo screen drawn', S12.frame().some((l) => l.includes(`\x1b[38;5;108m 17%\x1b[39m 11:20`)), true);

// ---- AC13: contrast, in the One Dark palette the approved design measured
// (docs/design/DS-227/index.html; 256-colour greys are 8 + 10 * (n - 232)).
const ONE_DARK = { 39: '#abb2bf' };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const grey = rgbOfSgr;
const lum = (c) => c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const fg = (code) => (code == null ? rgb(ONE_DARK[39]) : rgbOfSgr(code) ?? rgb(ONE_DARK[code]));
const windowBg = rgb('#282c34'), selected = grey('48;5;236');
const lineFor = (u, held) => Q.usageLine({ reading: { five_hour: win(u), seven_day: win(u), at: FIXED - 6 * MIN }, running: 0, held }, { now: FIXED, solid: true });
const all = [0.17, 0.6, 0.88].flatMap((u) => [lineFor(u, false), lineFor(u, true)]);
const bars = all.flatMap((l) => l.segs.filter(([s]) => /^█+$/.test(s)));
const text = all.flatMap((l) => l.segs.filter(([s]) => !/^█+$/.test(s) && s.trim()));
t('AC13 every text colour on the line is 4.5:1 or more on the window and the selected row',
  [...new Set(text.map(([, k]) => k))].filter((k) => [windowBg, selected].some((b) => contrast(fg(k), b) < 4.5)).join(), '');
const used = [...new Set(bars.map(([, k]) => k))].filter((k) => k !== '38;5;239');
t('AC13 each bar\'s used colour is 3:1 or more as a graphic: on the window, the selected row and the unused part',
  `${used.sort().join()} ${used.filter((k) => [windowBg, selected, grey('38;5;239')].some((b) => contrast(fg(k), b) < 3)).join()}`, '38;5;108,38;5;180,38;5;210 ');
// DS-277 AC3: with truecolor the bars are One Dark's 24-bit colours, as clear as the 256-colour ones.
process.env.COLORTERM = 'truecolor';
const QT = await import(`${pathToFileURL(join(BIN, 'desk-q.mjs')).href}?truecolor`);
delete process.env.COLORTERM;
const usedT = [...new Set([0.17, 0.6, 0.88].flatMap((u) => QT.usageLine({ reading: { five_hour: win(u), seven_day: win(u), at: FIXED - 6 * MIN }, running: 0, held: false }, { now: FIXED, solid: true })
  .segs.filter(([s]) => /^█+$/.test(s)).map(([, k]) => k)))].filter((k) => k !== '38;5;239');
t('DS-277 AC3 with truecolor each bar\'s used colour is One Dark\'s, 3:1 or more on the window, the selected row and the unused part',
  `${usedT.sort().join(' ')} ${usedT.filter((k) => [windowBg, selected, grey('38;5;239')].some((b) => contrast(fg(k), b) < 3)).join()}`, '38;2;152;195;121 38;2;229;192;123 38;2;240;124;132 ');

// ---- DS-215 AC21: on screen the line is labelled and pinned at the bottom: usage, a blank line, then
// the keys. Plain output keeps it in its header.
reading([0.17, at(24, 11, 20)], [0.6, at(25, 15, 0)]);
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const bottom = async (start) => {
  const S = screen(start);
  await sleep(20);
  S.ui.finish(0);
  const f = S.frame().map(plain);
  const i = f.findIndex((l) => l.startsWith(LABEL));
  const keys = f.findIndex((l) => /^(move  |↑↓ )/.test(l));
  return `${i === f.findLastIndex((l) => l.startsWith(LABEL))} ${keys - i} ${f.slice(i + 2).every((l) => /^(move|act|      )|↑↓|q quit/.test(l))} ${f[i]?.slice(LABEL.length).startsWith('5h ██')}`;
};
t('DS-215 AC21 home: the line once, a blank line then the keys under it, and nothing after the keys', await bottom({ kind: 'overview', all: false }), 'true 2 true true');
t('DS-215 AC21 a repo screen too', await bottom({ kind: 'repo', slug: 'acme__solo' }), 'true 2 true true');
const SR = screen({ kind: 'repo', slug: 'acme__solo' });
await sleep(20);
SR.ui.finish(0);
const fr = SR.frame().map(plain);
t('DS-215 AC21 and it is not also in the header, between the counts and the table',
  fr.slice(0, fr.findIndex((l) => l.includes('TICKET'))).some((l) => l.includes('5h ')), false);
t('DS-215 AC21 the label is grey', Q.usageLine({ reading: P.readUsage({ now: FIXED }), running: 1, held: false }, { now: FIXED }).segs[0].join('|'), `${LABEL}|38;5;247`);
t('DS-215 AC21 plain output keeps the labelled line in its header', usageAt(Q.overview(Q.loadRepos(FIXED), { now: FIXED, avail: 30 })), LINE);

console.log(fails ? `${fails} FAILED` : 'all desk-q usage checks passed');
process.exit(fails ? 1 : 0);
