// suite: desk-q Costs tab (every name's charge this month)
// desk-q against the October fixture cost cache and cost sources (tests/fixtures/costs-october), a
// fixed clock and a throwaway HOME, DESK_HOME, DESK_CONFIG_ROOT and cost directory. One check or more
// per acceptance criterion of DS-290 and of DS-291 (each row's tag and note, o to a billing page);
// DS-290's AC4-AC7 (Costs off home) are in test_desk_q.mjs beside the other tab checks.
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'desk', 'bin');
const FIX = join(HERE, 'fixtures', 'costs-october');
const T = mkdtempSync(join(tmpdir(), 'desk-q-costs-'));
mkdirSync(join(T, 'bin'));
writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_LOCK_DIR: join(T, 'locks'), DESK_USAGE_DIR: join(T, 'usage'), DESK_COST_DIR: join(T, 'costs'), DESK_COSTS: join(T, 'costs.md'),
  DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills'), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'COLORFGBG', 'COLORTERM', 'NO_COLOR']) delete process.env[k];
Object.assign(process.env, env);
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });
mkdirSync(env.DESK_COST_DIR, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');

// One repo with a batch, so home has a row and its needs-you and workers lines.
const slug = 'acme__solo';
mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
  '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `3100` |\n| Autopilot worker concurrency | `2 / 3` | `2 / 3` |\n');
const queue = join(env.DESK_HOME, 'repos', slug, 'queue.json');
mkdirSync(dirname(queue), { recursive: true });
writeFileSync(queue, JSON.stringify({ version: 1, batch: 'solo', concurrency: 2, tickets: { 'S-1': { key: 'S-1', state: 'triaged' } } }));

// Tuesday 27 October 2026, 11:05: the reading covers 1 to 26 October.
const FIXED = new Date(2026, 9, 27, 11, 5).getTime();
const sources = () => copyFileSync(join(FIX, 'costs.md'), env.DESK_COSTS);
const reading = () => copyFileSync(join(FIX, 'cache.json'), join(env.DESK_COST_DIR, 'cache.json'));
sources(); reading();

const Q = await import(join(BIN, 'desk-q.mjs'));
const { PassThrough } = await import('node:stream');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// The interactive screen on the fixed clock, with no probe or cost reading started; what it opens is
// kept in `opened`.
function screen(start = { kind: 'overview', all: false }, columns = 104) {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = { buf: '', columns, rows: 50, write(s) { this.buf += s; }, on() {}, removeListener() {} };
  const opened = [];
  const ui = Q.interactive({ input, output, start, exit() {}, refreshMs: 600000, clock: () => FIXED, opener: (u) => opened.push(u), probeWith: async () => ({ ran: false }), costWith: () => ({ started: false }) });
  const raw = () => output.buf.split('\x1b[H').at(-1).split('\r\n');
  const frame = () => raw().map((l) => l.replace(ANSI, ''));
  return {
    ui, frame, raw, opened,
    press: async (s) => { input.write(s); await sleep(20); },
    crumbs: () => frame()[0].replace(/ · \d\d:\d\d$/, ''),
    tabOn: () => /\x1b\[7m([^\x1b]+)\x1b\[27m/.exec(raw()[1] ?? '')?.[1] ?? null,
  };
}
const row = (name, amount, tag) => `  ${name.padEnd(14)}${amount.padStart(10)}${tag ? `  ${tag}` : ''}`;
const CHARGED = 'charged $899.97 in October, 1–26 │ GitHub $620.52 · AWS $175.88 · Vercel $103.57';
// The fixture's forewatt AWS reading is from 25 Oct and its attempt on 27 Oct failed.
const STALE = '◌ AWS last read 25 Oct, 2 days ago';
const TABLE = [
  `  ${'REPO'.padEnd(14)}${'CHARGED'.padStart(10)}`,
  row('voicepa', '$317.11'), row('pr-ninja', '$277.48', '▲ credits covered $31.73'), row('forewatt', '$119.42', STALE), row('desk-skills', '$110.45'),
  row('fansurge', '$55.19', 'AWS only, no repo in desk'), row('yield-index', '$0.48', '▲ credits covered $29.51'), row('gygg-platform', '$0.23'),
  row('pranicuk', '–', "◌ can't read: billed to GitHub account pranichealinguk"), row('shared', '$19.61', 'Vercel Pro plan $17.05 · GitHub storage $2.56'),
  row('total', '$899.97', 'includes 1 bill from 2 days ago'),
];
const NOTES = [
  'note  ▲ credits      AWS credits are covering $61.24 of use. It becomes a charge when they run out.',
  "      ◌ forewatt     Its AWS bill couldn't be read today, so this shows the 25 Oct figure. desk-q tries again every hour.",
];
const ALL_TABS = '1 Queue  2 Timeline  3 By day  4 Epics  5 Costs';
const keysAt = (f) => f.findIndex((l) => l.startsWith('↑↓ select') || l.startsWith('move  '));

// ---- AC1: home's tab line and keys
const H = screen();
await sleep(20);
t('AC1 home\'s tab line has 5 Costs after 4 Epics', H.frame()[1].startsWith(ALL_TABS), true);
t('AC1 home\'s keys read ←→ or 1–5 view', H.frame().slice(keysAt(H.frame())).join(' ').includes('←→ or 1–5 view'), true);

// ---- AC2: 5 on home shows every name's charge, most first, then shared and the total
await H.press('5');
const f2 = H.frame();
const at2 = f2.indexOf(CHARGED);
t('AC2 5 on home shows desk-q › costs, the Costs tab highlighted', `${H.crumbs()} | ${H.tabOn()}`, 'desk-q › costs | 5 Costs');
t('AC2 the charged line, with each supplier\'s total, most first', at2 > 0 && f2[at2 - 1] === '', true);
t('AC2 a REPO / CHARGED table, one row per name, largest first, then shared, then the total',
  f2.slice(at2 + 2, at2 + 2 + TABLE.length).map((l) => l.replace(/^›/, ' ')).join('\n'), TABLE.join('\n'));
t('AC2 the first name\'s row is selected', f2[at2 + 3].startsWith('› voicepa'), true);

// ---- AC3: the rows add up to the total row and the charged line, to the cent
// Read from what is drawn, the charged line found by its shape, so a sum that drifts fails here.
const cents = (s) => Math.round(Number(s.replace(/[$,]/g, '')) * 100);
const at3 = f2.findIndex((l) => l.startsWith('charged '));
const charged3 = cents(/^charged (\S+)/.exec(f2[at3] ?? '')?.[1] ?? 'NaN');
const lines3 = f2.slice(at3 + 3).filter((l) => /^[ ›] \S/.test(l)).map((l) => l.slice(1).trim().split(/\s+/));
const sum3 = lines3.filter(([n, a]) => n !== 'total' && a !== '–').reduce((a, [, s]) => a + cents(s), 0);
const total3 = cents(lines3.find(([n]) => n === 'total')?.[1] ?? 'NaN');
t('AC3 the rows sum to the total row and to the charged line, in cents', `${sum3 === total3} ${total3 === charged3} ${lines3.length}`, `true true ${TABLE.length - 1}`);
const bySupplier = [...(f2[at3] ?? '').matchAll(/(?:GitHub|AWS|Vercel) (\$[\d.,]+)/g)].map((m) => cents(m[1]));
t('AC3 the suppliers sum to the charged line too', `${bySupplier.length} ${bySupplier.reduce((a, c) => a + c, 0) === charged3}`, '3 true');

// ---- AC8: the Claude usage line above the keys, and none of home's batch lines
t('AC8 the Claude usage line sits above the keys, a blank line between', `${f2[keysAt(f2) - 2]?.startsWith('Claude usage  ')} ${f2[keysAt(f2) - 1]}`, 'true ');
t('AC8 no needs-you, workers or ports lines', f2.some((l) => /^◆ |^● \d+ worker|▲ ports|nothing needs you/.test(l)), false);

// ---- AC11: enter on a row changes nothing
const before11 = H.frame().join('\n');
await H.press('\r');
t('AC11 enter on a row leaves the screen as it is', `${H.frame().join('\n') === before11} ${H.crumbs()}`, 'true desk-q › costs');

// ---- AC12: at 104 columns no row is cut
t('AC12 at 104 columns no line is cut or wider', f2.filter((l) => l.endsWith('…') || [...l].length > 104).length, 0);
H.ui.finish(0);

// ---- AC13: desk-q costs, piped, prints this screen as plain text
const out13 = Q.run(['costs'], { now: FIXED });
const lines13 = out13.split('\n');
t('AC13 desk-q costs prints the charged line, a blank line and the table, as plain text',
  `${/\x1b/.test(out13)} | ${lines13.slice(0, 2 + TABLE.length).join('\n')}`, `false | ${[CHARGED, '', ...TABLE].join('\n')}`);
t('AC13 then a blank line, the notes unwrapped, a blank line and the Claude usage line', lines13.slice(2 + TABLE.length).join('|'), ['', ...NOTES, '', 'Claude usage  no reading yet'].join('|'));
const S13 = screen({ kind: 'costs' });
await sleep(20);
t('AC13 desk-q costs in a terminal opens home on its Costs tab', `${S13.crumbs()} | ${S13.tabOn()}`, 'desk-q › costs | 5 Costs');
S13.ui.finish(0);
let refused = '';
try { Q.run(['costs', 'voicepa'], { now: FIXED }); } catch (e) { refused = e.message; }
t('AC13 desk-q costs takes no further words', refused, 'Unknown command "costs voicepa". Try desk-q costs.');

// ---- DS-291: each row's tag and its note, and o to a billing page
const AMBER = '\x1b[38;5;180m', GREY = '\x1b[38;5;247m';
let variants = 0;
const costsAt = async (cache, columns = 104) => {
  const S = screen(undefined, columns);
  await sleep(20);
  if (cache) {
    process.env.DESK_COST_DIR = join(T, `variant-${++variants}`);
    mkdirSync(process.env.DESK_COST_DIR);
    writeFileSync(join(process.env.DESK_COST_DIR, 'cache.json'), JSON.stringify(cache));
  }
  await S.press('5');
  return S;
};
const rawRow = (S, name) => S.raw().find((l) => l.replace(ANSI, '').slice(2).startsWith(`${name} `)) ?? '';
const rowEnd = (S, name) => (S.frame().find((l) => l.slice(2).startsWith(`${name} `)) ?? '').slice(28);
// A note's text, its wrapped lines joined.
const noteText = (S, tag) => {
  const f = S.frame();
  const i = f.findIndex((l) => l.slice(6).startsWith(tag));
  if (i < 0) return null;
  const out = [f[i].slice(21)];
  for (let j = i + 1; f[j]?.startsWith(' '.repeat(21)); j++) out.push(f[j].trim());
  return out.join(' ');
};
const fixture = () => JSON.parse(readFileSync(join(FIX, 'cache.json'), 'utf8'));
const MAIN = env.DESK_COST_DIR;

const D = await costsAt(null);
t('DS-291 AC1 a name AWS credits covered ends in its credits, amber', `${rowEnd(D, 'pr-ninja')} | ${rawRow(D, 'pr-ninja').includes(`${AMBER}▲ credits covered $31.73`)}`, '▲ credits covered $31.73 | true');
t('DS-291 AC2 a name with no repo in desk names its suppliers, grey', `${rowEnd(D, 'fansurge')} | ${rawRow(D, 'fansurge').includes(`${GREY}AWS only, no repo in desk`)}`, 'AWS only, no repo in desk | true');
t('DS-291 AC4 a name that can\'t be read reads –, says why in grey, and adds nothing to the total',
  `${D.frame().find((l) => l.slice(2).startsWith('pranicuk '))?.slice(16, 26).trim()} | ${rowEnd(D, 'pranicuk')} | ${rawRow(D, 'pranicuk').includes(`${GREY}◌ can't read`)} | ${D.frame().some((l) => /^ {2}total +\$899\.97/.test(l))}`,
  "– | ◌ can't read: billed to GitHub account pranichealinguk | true | true");
t('DS-291 AC5 a bill whose reading failed today ends in when it was last read, the total in how many are old',
  `${rowEnd(D, 'forewatt')} | ${rowEnd(D, 'total')}`, `${STALE} | includes 1 bill from 2 days ago`);
t('DS-291 AC5 and a ◌ forewatt note says why', noteText(D, '◌ forewatt'), "Its AWS bill couldn't be read today, so this shows the 25 Oct figure. desk-q tries again every hour.");
t('DS-291 AC7 the shared row names its lines, grey', `${rowEnd(D, 'shared')} | ${rawRow(D, 'shared').includes(`${GREY}Vercel Pro plan $17.05 · GitHub storage $2.56`)}`, 'Vercel Pro plan $17.05 · GitHub storage $2.56 | true');
t('DS-291 AC8 a ▲ credits note says what credits cover', `${noteText(D, '▲ credits')} | ${D.raw().some((l) => l.includes(`${AMBER}▲ credits      `))}`,
  'AWS credits are covering $61.24 of use. It becomes a charge when they run out. | true');
const f9 = D.frame();
const at9 = f9.findIndex((l) => l.slice(6).startsWith('◌ forewatt'));
t('DS-291 AC9 at 104 columns a note wraps with its text indented under its first line',
  `${f9[at9]?.endsWith('desk-q tries')} | ${f9[at9 + 1]} | ${f9.every((l) => [...l].length <= 104)}`, `true | ${' '.repeat(21)}again every hour. | true`);
t('DS-291 AC10 the keys say o opens the bill', D.frame().slice(keysAt(D.frame())).join(' ').includes('o open the bill'), true);
await D.press('o');
for (let i = 0; i < 4; i++) await D.press('\x1b[B');
await D.press('o');
await D.press('\x1b[B');
await D.press('o');
t('DS-291 AC10 o opens the largest supplier\'s billing page: GitHub for voicepa, AWS for fansurge, the team\'s Vercel page for yield-index', D.opened.join(' '),
  'https://github.com/settings/billing/usage https://console.aws.amazon.com/costmanagement/home#/cost-explorer https://vercel.com/ben-lavenders-projects/~/usage');
D.ui.finish(0);

// AC3: a public repo whose CI minutes the cache marks as discounted in full.
const pub = fixture();
pub.github.repos['bigbenjoman/desk-skills'].items[0] = { ...pub.github.repos['bigbenjoman/desk-skills'].items[0], charged: 0, discount: 'full' };
pub.github.repos['bigbenjoman/desk-skills'].total = 0;
const P = await costsAt(pub);
t('DS-291 AC3 a repo whose CI minutes were all discounted in full ends public, grey', `${rowEnd(P, 'desk-skills')} | ${rawRow(P, 'desk-skills').includes(`${GREY}public, so its CI is free`)}`, 'public, so its CI is free | true');
P.ui.finish(0);

// AC6: no attempt yet today, the last good reading from 25 Oct.
const unread = fixture();
unread.aws.profiles.forewatt.failed = null;
const U = await costsAt(unread);
t('DS-291 AC6 a bill not read yet today carries the same tags', `${rowEnd(U, 'forewatt')} | ${rowEnd(U, 'total')}`, `${STALE} | includes 1 bill from 2 days ago`);
t('DS-291 AC6 and its note says it hasn\'t been read yet', noteText(U, '◌ forewatt'), "Its AWS bill hasn't been read yet today, so this shows the 25 Oct figure.");
U.ui.finish(0);
process.env.DESK_COST_DIR = MAIN;

// ---- AC10: sources set up, no reading yet
copyFileSync(join(FIX, 'costs.md'), env.DESK_COSTS);
process.env.DESK_COST_DIR = join(T, 'no-reading');
const S10 = screen();
await sleep(20);
await S10.press('5');
t('AC10 with sources and no reading, the screen says so', S10.frame().includes(Q.NO_COST_READING) && Q.NO_COST_READING, 'No cost reading yet. desk-q reads them in the background.');
S10.ui.finish(0);
// A first reading whose every call failed has a period and no figure: still no reading, never $0.00.
process.env.DESK_COST_DIR = join(T, 'failed-reading');
mkdirSync(process.env.DESK_COST_DIR);
const failed = { at: FIXED, why: 'not signed in' };
const october = { year: 2026, month: 10, from: '2026-10-01', to: '2026-10-26' };
writeFileSync(join(process.env.DESK_COST_DIR, 'cache.json'), JSON.stringify({
  github: { at: FIXED, period: october, repos: { 'bigbenjoman/voicepa': { name: 'voicepa', failed } }, shared: { bigbenjoman: { failed } } },
  vercel: { at: FIXED, period: october, teams: { team_ben: { team: 'ben-lavenders-projects', plan: 'pro', owner: null, failed } }, names: {}, shared: 0 },
}));
const S10f = screen();
await sleep(20);
await S10f.press('5');
t('AC10 a first reading whose every call failed reads as no reading, not $0.00',
  `${S10f.frame().includes(Q.NO_COST_READING)} ${S10f.frame().some((l) => l.startsWith('charged '))}`, 'true false');
S10f.ui.finish(0);
// A Vercel reading that worked and charged nothing writes the same totals, but its team holds lines.
writeFileSync(join(process.env.DESK_COST_DIR, 'cache.json'), JSON.stringify({
  vercel: { at: FIXED, period: october, teams: { team_ben: { team: 'ben-lavenders-projects', plan: 'hobby', owner: null, at: FIXED, total: 0, failed: null,
    lines: [{ kind: 'plan', label: 'Hobby', name: null, charged: 0 }] } }, names: {}, shared: 0 },
}));
const S10z = screen();
await sleep(20);
await S10z.press('5');
t('AC10 a reading that worked and charged nothing reads $0.00, not as no reading',
  S10z.frame().find((l) => l.startsWith('charged ')) ?? null, 'charged $0.00 in October, 1–26 │ Vercel $0.00');
S10z.ui.finish(0);
// AWS reads each profile on its own day: a profile that failed first time has no figure, and one
// whose last good figures are from September is left out of October's.
const awsProfile = (name, period, total) => ({ profile: name, name, repo: null, credit: null, at: FIXED, period, total, failed: null,
  lines: [{ service: 'Amazon Simple Storage Service', used: total, credits: 0, charged: total }] });
writeFileSync(join(process.env.DESK_COST_DIR, 'cache.json'), JSON.stringify({
  aws: { at: FIXED, profiles: {
    voicepa: awsProfile('voicepa', october, 1.59),
    forewatt: awsProfile('forewatt', { year: 2026, month: 9, from: '2026-09-01', to: '2026-09-30' }, 119.1),
    fansurge: { profile: 'fansurge', name: 'fansurge', repo: null, credit: null, failed },
  } },
}));
const S10a = screen();
await sleep(20);
await S10a.press('5');
const f10a = S10a.frame();
t('AC10 AWS counts only the profiles read for this month',
  `${f10a.find((l) => l.startsWith('charged '))} | ${f10a.filter((l) => /^[ ›] (forewatt|fansurge) /.test(l)).map((l) => l.slice(1).trim().split(/\s+/).slice(0, 2).join(' ')).join(', ')}`,
  'charged $1.59 in October, 1–26 │ AWS $1.59 | fansurge –, forewatt –');
S10a.ui.finish(0);

// ---- AC9: no cost sources on the machine
process.env.DESK_COSTS = join(T, 'no-costs.md');
const S9 = screen();
await sleep(20);
await S9.press('5');
t('AC9 with no cost sources, the screen says how to add them', S9.frame().includes(Q.NO_COST_SOURCES) && Q.NO_COST_SOURCES, 'No cost sources set up. /desk-setup costs adds them.');
t('AC9 and still carries the Claude usage line', S9.frame().some((l) => l.startsWith('Claude usage  ')), true);
S9.ui.finish(0);

console.log(fails ? `${fails} FAILED` : 'all desk-q costs checks passed');
process.exit(fails ? 1 : 0);
