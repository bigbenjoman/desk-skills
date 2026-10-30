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
// voicepa is set up here with no batch, so its costs open on its place; pr-ninja is not, so its open on a place of their own.
mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', 'bigbenjoman__voicepa'), { recursive: true });
writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', 'bigbenjoman__voicepa', 'config.md'),
  '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `3200` |\n');

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
    press: async (s) => { input.write(s); await sleep(s === '\x1b' ? 600 : 20); },
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
// The fixture saves a $600 Actions budget, and its Actions minutes come to $617.96 (storage left out).
const BUDGET_NOTE = 'note  ▲ budget       GitHub Actions budget used up: $617.96 of $600.00.';
const NOTES = [
  BUDGET_NOTE,
  '      ▲ credits      AWS credits are covering $61.24 of use. It becomes a charge when they run out.',
  "      ◌ forewatt     Its AWS bill couldn't be read today, so this shows the 25 Oct figure. desk-q tries again every hour.",
];
const ALL_TABS = '1 Queue  2 Timeline  3 By day  4 Epics  5 Costs';
const keysAt = (f) => f.findIndex((l) => l.startsWith('↑↓ select') || l.startsWith('←→ or 1–5 view') || l.startsWith('move  '));

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

// ---- AC11 (DS-292 opens a name): enter on the shared row changes nothing
for (let i = 0; i < 8; i++) await H.press('\x1b[B');
const before11 = H.frame().join('\n');
await H.press('\r');
t('AC11 enter on the shared row leaves the screen as it is', `${H.frame().join('\n') === before11} ${H.crumbs()}`, 'true desk-q › costs');

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
try { Q.run(['costs', 'voicepa', 'github'], { now: FIXED }); } catch (e) { refused = e.message; }
t('AC13 desk-q costs takes a repo and no further words', refused, 'Unknown command "costs voicepa github". Try desk-q costs [<repo>].');

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

// ---- DS-292: enter on a name in Costs shows its charge by supplier
const sup = (name, what, amount, tag) => `  ${name.padEnd(10)}${what.padEnd(24)}${amount.padStart(11)}${tag ? `  ${tag}` : ''}`;
const supTotal = (amount) => `  ${'total'.padEnd(34)}${amount.padStart(11)}`;
const SUP_HEAD = `  ${'SUPPLIER'.padEnd(10)}${'FOR'.padEnd(24)}${'CHARGED'.padStart(11)}`;
const VOICEPA = ['charged $317.11 to voicepa in October, 1–26', '', SUP_HEAD,
  sup('GitHub', 'CI minutes', '$255.74'), sup('Vercel', 'hosting and builds', '$59.78'), sup('AWS', 'hosting and CI runners', '$1.59'), supTotal('$317.11')];
const PR_NINJA = ['charged $277.48 to pr-ninja in October, 1–26', '', SUP_HEAD,
  sup('GitHub', 'CI minutes', '$251.33'), sup('Vercel', 'hosting and builds', '$26.15'), sup('AWS', 'hosting and CI runners', '$0.00', '▲ on credits'), supTotal('$277.48')];
const CREDITS_NOTE = '      ▲ credits      AWS credits covered $31.73. Without them, pr-ninja would have been charged $309.21.';
const block = (S, first, n) => { const f = S.frame(); const i = f.indexOf(first); return i < 0 ? null : f.slice(i, i + n).map((l) => l.replace(/^›/, ' ')).join('\n'); };
const selected = (S) => S.frame().find((l) => l.startsWith('›')) ?? '';
const supRaw = (S, name) => S.raw().find((l) => l.replace(ANSI, '').slice(2).startsWith(`${name} `)) ?? '';

const V = await costsAt(null);
await V.press('\r');
t('DS-292 AC1 enter on voicepa: desk-q › costs › voicepa, the Costs tab highlighted', `${V.crumbs()} | ${V.tabOn()}`, 'desk-q › costs › voicepa | 5 Costs');
t('DS-292 AC1 the charged line, then a SUPPLIER / FOR / CHARGED table, largest first, and a total row', block(V, VOICEPA[0], VOICEPA.length), VOICEPA.join('\n'));
t('DS-292 AC1 the largest supplier is selected', selected(V).startsWith('› GitHub'), true);
const fv = V.frame();
const supCents = fv.filter((l) => /^[ ›] (GitHub|Vercel|AWS) /.test(l)).map((l) => cents(l.slice(36, 47).trim()));
const supSum = supCents.reduce((a, c) => a + c, 0);
const supTot = cents(fv.find((l) => l.startsWith('  total '))?.slice(36, 47).trim() ?? 'NaN');
t('DS-292 AC2 the rows sum to the total row and to voicepa\'s row on the Costs tab, in cents', `${supCents.length} ${supSum === supTot} ${supTot === cents('$317.11')}`, '3 true true');
t('DS-292 AC3 FOR is fixed by supplier', fv.filter((l) => /^[ ›] (GitHub|Vercel|AWS) /.test(l)).map((l) => `${l.slice(2, 12).trim()}: ${l.slice(12, 36).trim()}`).join(' | '),
  'GitHub: CI minutes | Vercel: hosting and builds | AWS: hosting and CI runners');
t('DS-292 AC12 at 104 columns no line is cut or wider, and the Claude usage line sits above the keys',
  `${fv.filter((l) => l.endsWith('…') || [...l].length > 104).length} ${fv[keysAt(fv) - 2]?.startsWith('Claude usage  ')} ${fv[keysAt(fv) - 1]}`, '0 true ');
t('DS-292 the keys say o opens the bill, and esc goes back', ['o open the bill', 'esc back'].every((k) => fv.slice(keysAt(fv)).join(' ').includes(k)), true);

// ---- DS-293: enter on a supplier opens its screen; GitHub's shows its runners and this month against last
const what = (label, used, amount) => `  ${label.padEnd(17)}${used.padStart(14)}${amount.padStart(13)}`;
const month = (label, amount, tag) => `  ${label.padEnd(31)}${amount.padStart(13)}${tag ? `  ${tag}` : ''}`;
const WHAT_HEAD = what('WHAT', 'USED', 'CHARGED'), MONTH_HEAD = month('MONTH', 'CHARGED');
const UP = '▲ 1.9× September, with 5 days to go';
const GITHUB = ['charged $255.74 by GitHub to voicepa in October, 1–26', '', WHAT_HEAD, what('Linux runners', '44,972 min', '$255.74'), month('total', '$255.74'),
  '', MONTH_HEAD, month('September', '$131.67'), month('October, 1–26', '$255.74', UP)];
await V.press('\r');
const fg = V.frame();
t('DS-293 AC1 enter on GitHub: desk-q › costs › voicepa › GitHub, the Costs tab highlighted', `${V.crumbs()} | ${V.tabOn()}`, 'desk-q › costs › voicepa › GitHub | 5 Costs');
t('DS-293 AC1 AC5 AC6 the charged line, a WHAT / USED / CHARGED table and a MONTH / CHARGED table', block(V, GITHUB[0], GITHUB.length), GITHUB.join('\n'));
const whatCents = fg.slice(fg.indexOf(WHAT_HEAD) + 1, fg.findIndex((l) => l.startsWith('  total '))).map((l) => cents(l.slice(33).trim()));
t('DS-293 AC4 the WHAT rows sum to its total and to the GitHub row on voicepa\'s screen, in cents',
  `${whatCents.length} ${whatCents.reduce((a, c) => a + c, 0) === cents(fg.find((l) => l.startsWith('  total '))?.slice(33).trim() ?? 'NaN')} ${whatCents.reduce((a, c) => a + c, 0) === cents('$255.74')}`, '1 true true');
t('DS-293 AC6 the ▲ tag is amber', V.raw().some((l) => l.includes(`${AMBER}  ${UP}`)), true);
t('DS-293 AC12 at 104 columns no line is cut or wider, and the Claude usage line sits above the keys',
  `${fg.filter((l) => l.endsWith('…') || [...l].length > 104).length} ${fg[keysAt(fg) - 2]?.startsWith('Claude usage  ')} ${fg[keysAt(fg) - 1]}`, '0 true ');
t('DS-293 the keys say o opens GitHub billing, and esc goes back', ['o open GitHub billing', 'esc back'].every((k) => fg.slice(keysAt(fg)).join(' ').includes(k)), true);
await V.press('o');
t('DS-293 AC11 o opens GitHub\'s billing page', V.opened.join(' '), 'https://github.com/settings/billing/usage');
V.opened.length = 0;
await V.press('\x1b');
t('DS-293 AC9 esc: back on voicepa by supplier, GitHub selected', `${V.crumbs()} | ${V.tabOn()} | ${selected(V).startsWith('› GitHub ')}`, 'desk-q › costs › voicepa | 5 Costs | true');
await V.press('o');
await V.press('\x1b[B');
await V.press('o');
await V.press('\x1b[B');
await V.press('o');
t('DS-292 AC10 o opens the selected supplier\'s billing page', V.opened.join(' '),
  'https://github.com/settings/billing/usage https://vercel.com/voice-pa/~/usage https://console.aws.amazon.com/costmanagement/home#/cost-explorer');
// DS-293 AC10: Vercel's and AWS's screens are places too, with their charged line.
await V.press('\r');
const aws10 = `${V.crumbs()} | ${V.frame().find((l) => l.startsWith('charged '))}`;
await V.press('\x1b');
const awsBack = selected(V).startsWith('› AWS ');
await V.press('\x1b[A');
await V.press('\r');
const vercel10 = `${V.crumbs()} | ${V.frame().find((l) => l.startsWith('charged '))}`;
await V.press('\x1b');
t('DS-293 AC10 enter on AWS, then on Vercel: each one\'s breadcrumb and charged line, and esc back with it selected',
  `${aws10} | ${awsBack} || ${vercel10} | ${selected(V).startsWith('› Vercel ')}`,
  'desk-q › costs › voicepa › AWS | charged $1.59 by AWS to voicepa in October, 1–26 · account voicepa-admin | true || '
  + 'desk-q › costs › voicepa › Vercel | charged $59.78 by Vercel to voicepa in October, 1–26 · team voice-pa | true');
await V.press('\x1b');
t('DS-292 AC6 esc: back on the Costs tab, voicepa selected', `${V.crumbs()} | ${V.tabOn()} | ${selected(V).startsWith('› voicepa ')}`, 'desk-q › costs | 5 Costs | true');
await V.press('\x1b[B');
await V.press('\r');
t('DS-292 AC4 pr-ninja by supplier, its AWS row on credits', block(V, PR_NINJA[0], PR_NINJA.length), PR_NINJA.join('\n'));
t('DS-292 AC4 ▲ on credits is amber', supRaw(V, 'AWS').includes(`${AMBER}▲ on credits`), true);
t('DS-292 AC4 a ▲ credits note says what they covered and what it would have been', `${V.frame().includes(CREDITS_NOTE)} ${V.raw().some((l) => l.includes(`${AMBER}▲ credits      `))}`, 'true true');
const notAt = V.frame().join('\n');
await V.press('1');
t('DS-292 a name whose repo isn\'t set up here has only Costs, and says so', `${V.frame().join('\n') !== notAt} ${V.crumbs()} | ${V.tabOn()} | ${V.frame().includes(Q.onlyCosts('pr-ninja'))}`, 'true desk-q › costs › pr-ninja | 5 Costs | true');
await V.press('\x1b');
await V.press('\x1b[B');
await V.press('\r');
t('DS-292 AC5 a supplier last read before today ends in when, grey', `${V.crumbs()} | ${supRaw(V, 'AWS').replace(ANSI, '').slice(49)} | ${supRaw(V, 'AWS').includes(`${GREY}◌ last read 25 Oct, 2 days ago`)}`,
  'desk-q › costs › forewatt | ◌ last read 25 Oct, 2 days ago | true');
V.ui.finish(0);

// AC7-AC8: on voicepa's own place, 5 shows it by supplier; esc goes up to home's Costs.
const VP = screen({ kind: 'repo', slug: 'bigbenjoman__voicepa' });
await sleep(20);
t('DS-292 AC7 voicepa\'s place has 5 Costs, not dimmed', VP.raw()[1].includes(`${GREY}5 Costs`), false);
await VP.press('5');
t('DS-292 AC7 5 on voicepa\'s place shows voicepa by supplier', `${VP.crumbs()} | ${VP.tabOn()} | ${block(VP, VOICEPA[0], VOICEPA.length) === VOICEPA.join('\n')}`, 'desk-q › costs › voicepa | 5 Costs | true');
await VP.press('\x1b');
t('DS-292 AC8 esc: home\'s Costs tab, voicepa selected', `${VP.crumbs()} | ${VP.tabOn()} | ${selected(VP).startsWith('› voicepa ')}`, 'desk-q › costs | 5 Costs | true');
VP.ui.finish(0);

// DS-293 AC2, AC3, AC7, AC8: voicepa's GitHub screen from its own place, on a variant reading.
const githubAt = async (cache) => {
  process.env.DESK_COST_DIR = join(T, `variant-${++variants}`);
  mkdirSync(process.env.DESK_COST_DIR);
  writeFileSync(join(process.env.DESK_COST_DIR, 'cache.json'), JSON.stringify(cache));
  const S = screen({ kind: 'repo', slug: 'bigbenjoman__voicepa' });
  await sleep(20);
  await S.press('5');
  await S.press('\r');
  return S;
};
const runners = fixture();
const vp = runners.github.repos['bigbenjoman/voicepa'];
const sku = (name, quantity, charged) => ({ sku: name, product: 'actions', unit: 'Minutes', quantity, charged, discount: 'none' });
vp.items = [sku('actions_linux', 44972, 200.5), sku('actions_macos', 1200, 30.24), sku('actions_windows', 900, 15), sku('actions_linux_16_core', 160, 10)];
vp.total = 255.74;
const R = await githubAt(runners);
const fr = R.frame();
t('DS-293 AC2 AC3 one row per runner type, most charged first; one desk has no name for reads as GitHub\'s SKU',
  fr.slice(fr.findIndex((l) => l.startsWith('  WHAT ')), fr.findIndex((l) => l.startsWith('  total '))).join('\n'),
  [['WHAT', 'USED', 'CHARGED'], ['Linux runners', '44,972 min', '$200.50'], ['macOS runners', '1,200 min', '$30.24'], ['Windows runners', '900 min', '$15.00'],
    ['actions_linux_16_core', '160 min', '$10.00']].map(([l, u, a]) => `  ${l.padEnd(23)}${u.padStart(14)}${a.padStart(13)}`).join('\n'));
R.ui.finish(0);
const equal = fixture();
equal.github.lastMonth.repos['bigbenjoman/voicepa'].total = 255.74;
const E7 = await githubAt(equal);
t('DS-293 AC7 this month at last month\'s charge has no tag', E7.frame().find((l) => l.startsWith('  October, 1–26 ')), month('October, 1–26', '$255.74'));
E7.ui.finish(0);
const none = fixture();
delete none.github.lastMonth.repos['bigbenjoman/voicepa'];
const N8 = await githubAt(none);
const f8 = N8.frame();
t('DS-293 AC8 with no reading for last month, the MONTH table has this month only', f8.slice(f8.indexOf(MONTH_HEAD), f8.indexOf(MONTH_HEAD) + 3).join('\n'), [MONTH_HEAD, month('October, 1–26', '$255.74'), ''].join('\n'));
N8.ui.finish(0);
process.env.DESK_COST_DIR = MAIN;

// AC9: a repo with no cost sources.
const SO = screen({ kind: 'repo', slug: slug });
await sleep(20);
await SO.press('5');
t('DS-292 AC9 5 on a repo with no cost sources says how to add them', SO.frame().includes(Q.noCostSourcesFor('solo')) && Q.noCostSourcesFor('solo'), 'No cost sources for solo. /desk-setup costs adds them.');
SO.ui.finish(0);

// AC13: desk-q costs <repo>, piped, prints this screen as plain text.
const out292 = Q.run(['costs', 'voicepa'], { now: FIXED });
t('DS-292 AC13 desk-q costs voicepa prints the screen as plain text', `${/\x1b/.test(out292)} | ${out292}`, `false | ${[...VOICEPA, '', BUDGET_NOTE, '', 'Claude usage  no reading yet'].join('\n')}`);
t('DS-292 AC13 and pr-ninja\'s, its notes unwrapped', Q.run(['costs', 'pr-ninja'], { now: FIXED }), [...PR_NINJA, '', BUDGET_NOTE, CREDITS_NOTE, '', 'Claude usage  no reading yet'].join('\n'));
t('DS-292 AC13 and a repo with no cost sources says so', Q.run(['costs', 'solo'], { now: FIXED }).split('\n')[0], Q.noCostSourcesFor('solo'));
// A second AWS profile under voicepa, read today and since removed from costs.md.
const gone = fixture();
gone.aws.profiles['voicepa-old'] = { ...gone.aws.profiles['voicepa-admin'], profile: 'voicepa-old', lines: [{ service: 'Amazon EC2', used: 40, credits: 0, charged: 40 }], total: 40 };
t('DS-325 AC3 a profile removed from costs.md is in no supplier\'s figure', Q.supplierScreen([], 'voicepa', { now: FIXED, cache: gone, pinUsage: true }).split('\n').slice(0, VOICEPA.length).join('\n'), VOICEPA.join('\n'));
const awsPage = (cache) => JSON.stringify(Q.supplierPageParts([], 'voicepa', 'aws', { now: FIXED, cache }).head);
t('DS-293 AC10 (DS-325 AC3) the AWS screen leaves out a profile removed from costs.md, as the repo screen does', awsPage(gone), awsPage(fixture()));

// ---- DS-296: home's Charged line under Claude usage, and its budget and credits notes
// Home on a cost reading and cost sources, each written to its own place.
const homeAt = async ({ cache = fixture(), costs = readFileSync(join(FIX, 'costs.md'), 'utf8'), columns = 104 } = {}) => {
  process.env.DESK_COST_DIR = join(T, `variant-${++variants}`);
  mkdirSync(process.env.DESK_COST_DIR);
  if (cache) writeFileSync(join(process.env.DESK_COST_DIR, 'cache.json'), JSON.stringify(cache));
  process.env.DESK_COSTS = join(T, `costs-${variants}.md`);
  if (costs) writeFileSync(process.env.DESK_COSTS, costs);
  const S = screen(undefined, columns);
  await sleep(20);
  return S;
};
const chargedOf = (S) => S.frame().find((l) => l.startsWith('Charged ')) ?? null;
const budgetSaved = (usd) => readFileSync(join(FIX, 'costs.md'), 'utf8').replace('| `actions-budget-usd` | `600` |', `| \`actions-budget-usd\` | \`${usd}\` |`);
// forewatt's AWS figure read today, so no figure is old.
const fresh = fixture();
Object.assign(fresh.aws.profiles.forewatt, { at: FIXED, failed: null });
const CHARGED_HOME = 'Charged       $899.97 in October, 1–26 │ GitHub $620.52 · AWS $175.88 · Vercel $103.57';

const H1 = await homeAt({ cache: fresh });
const f1 = H1.frame();
t('DS-296 AC1 the line under Claude usage reads Charged, both labels the same width, above a blank line and the keys',
  `${f1[keysAt(f1) - 3]?.slice(0, 14)}| ${f1[keysAt(f1) - 2]} | ${f1[keysAt(f1) - 1]}`, `Claude usage  | ${CHARGED_HOME} | `);
const sup1 = [...(chargedOf(H1) ?? '').matchAll(/(?:GitHub|AWS|Vercel) (\$[\d.,]+)/g)].map((m) => cents(m[1]));
const total1 = cents(/^Charged +(\S+)/.exec(chargedOf(H1) ?? '')?.[1] ?? 'NaN');
await H1.press('5');
const costsTotal = cents(H1.frame().find((l) => /^ {2}total /.test(l))?.trim().split(/\s+/)[1] ?? 'NaN');
t('DS-296 AC2 its suppliers add up to its total and to the Costs tab\'s total, in cents',
  `${sup1.length} ${sup1.reduce((a, c) => a + c, 0) === total1} ${total1 === costsTotal}`, '3 true true');
H1.ui.finish(0);

const H3 = await homeAt({ cache: null, costs: null });
const f3 = H3.frame();
t('DS-296 AC3 with no cost sources, no Charged line, and the usage line sits where it does today',
  `${chargedOf(H3)} | ${f3[keysAt(f3) - 2]?.startsWith('Claude usage  ')} | ${f3[keysAt(f3) - 1]}`, 'null | true | ');
H3.ui.finish(0);

const H4 = await homeAt({ cache: null });
t('DS-296 AC4 with sources and no reading, the line reads no reading yet, grey',
  `${chargedOf(H4)} | ${H4.raw().some((l) => l.includes(`${GREY}Charged       no reading yet`))}`, 'Charged       no reading yet | true');
H4.ui.finish(0);

// The fixture's Actions minutes are $617.96 on bigbenjoman: $2.56 of storage and pranicuk's other account are left out.
const H5 = await homeAt();
t('DS-296 AC5 a saved budget the Actions minutes reach: a ▲ budget note, amber',
  `${noteText(H5, '▲ budget')} | ${H5.raw().some((l) => l.includes(`${AMBER}▲ budget       `))}`, 'GitHub Actions budget used up: $617.96 of $600.00. | true');
t('DS-296 AC7 a ▲ credits note names who credits are covering',
  `${noteText(H5, '▲ credits')} | ${H5.raw().some((l) => l.includes(`${AMBER}▲ credits      `))}`,
  'AWS credits are covering $61.24 of use for pr-ninja and yield-index. It becomes a charge when they run out. | true');
const f10 = H5.frame();
const at10 = f10.findIndex((l) => l.slice(6).startsWith('▲ credits'));
const charged10 = f10.indexOf(CHARGED_HOME);
t('DS-296 AC10 at 104 columns the Charged line and both notes fit, a note wrapping under its first line, the old bill under the figures',
  `${f10.filter((l) => l.endsWith('…') || [...l].length > 104).length} | ${f10[at10 + 1]?.startsWith(`${' '.repeat(21)}charge when`)} | ${f10[charged10 + 1]}`,
  `0 | true | ${' '.repeat(14)}◌ 1 bill from 2 days ago`);
H5.ui.finish(0);
const H9 = await homeAt({ columns: 140 });
t('DS-296 AC9 a figure last read two days ago ends the Charged line, grey',
  `${chargedOf(H9)} | ${H9.raw().some((l) => l.includes(`${GREY}  ◌ 1 bill from 2 days ago`))}`, `${CHARGED_HOME}  ◌ 1 bill from 2 days ago | true`);
H9.ui.finish(0);

const H6 = await homeAt({ costs: budgetSaved('617.97') });
const H6n = await homeAt({ costs: budgetSaved('none') });
t('DS-296 AC6 under the budget, or with none saved, no budget note', `${noteText(H6, '▲ budget')} | ${noteText(H6n, '▲ budget')}`, 'null | null');
H6.ui.finish(0);
H6n.ui.finish(0);
const H6e = await homeAt({ costs: budgetSaved('617.96') });
t('DS-296 AC5 at the budget to the cent, the note', noteText(H6e, '▲ budget'), 'GitHub Actions budget used up: $617.96 of $617.96.');
H6e.ui.finish(0);
const nc = fixture();
for (const p of Object.values(nc.aws.profiles)) for (const l of p.lines ?? []) l.credits = 0;
const H7n = await homeAt({ cache: nc });
t('DS-296 AC7 with no credits covering use, no credits note', noteText(H7n, '▲ credits'), null);
H7n.ui.finish(0);

// AC8: the Costs tab, voicepa's screen and its GitHub screen carry the same note.
const H8 = await homeAt();
await H8.press('5');
const tab8 = noteText(H8, '▲ budget');
await H8.press('\r');
const repo8 = noteText(H8, '▲ budget');
await H8.press('\r');
const gh8 = `${H8.crumbs()} | ${noteText(H8, '▲ budget')}`;
t('DS-296 AC8 the Costs tab, a repo\'s screen and the GitHub screen carry the ▲ budget note', `${tab8} | ${repo8} | ${gh8}`,
  ['GitHub Actions budget used up: $617.96 of $600.00.', 'GitHub Actions budget used up: $617.96 of $600.00.',
    'desk-q › costs › voicepa › GitHub', 'GitHub Actions budget used up: $617.96 of $600.00.'].join(' | '));
H8.ui.finish(0);
process.env.DESK_COST_DIR = MAIN;
process.env.DESK_COSTS = env.DESK_COSTS;

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
// whose last good figures are from September is left out of October's. Each profile is the one
// costs.md lists, as one it doesn't is in no total.
const awsProfile = (name, period, total, profile = name) => ({ profile, name, repo: null, credit: null, at: FIXED, period, total, failed: null,
  lines: [{ service: 'Amazon Simple Storage Service', used: total, credits: 0, charged: total }] });
writeFileSync(join(process.env.DESK_COST_DIR, 'cache.json'), JSON.stringify({
  aws: { at: FIXED, profiles: {
    'voicepa-admin': awsProfile('voicepa', october, 1.59, 'voicepa-admin'),
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
