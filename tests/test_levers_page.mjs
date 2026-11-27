// suite: levers page (the offline Levers page rendered from view.json)
// layer: L1
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const j = (v) => JSON.stringify(v);
process.env.HOME = scratch('levers-page-home-');
const V = await import('../desk/bin/levers-view.mjs');
const P = await import('../desk/bin/levers-page.mjs');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const w = (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const count = (s, re) => (s.match(re) ?? []).length;

// The page's CSS, read as a browser would enough to check it: `subjects` holds each class some rule
// selects (the last compound of a selector, a class inside :not() aside), and style(el, ancestors)
// gives the declarations the rules outside @media give an element { tag, classes } under its ancestors
// (nearest last), by specificity then order. A compound with a pseudo-class other than :not, or an
// attribute, never matches here.
function cssChecks(css) {
  const rules = (text) => [...text.replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m, order) => ({ sels: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2], order }));
  const compounds = (sel) => sel.replace(/\s*([>+~])\s*/g, ' $1 ').trim().split(/\s+/);
  const parse = (c) => {
    const nots = [...c.matchAll(/:not\(\.([\w-]+)\)/g)].map((m) => m[1]);
    const rest = c.replace(/:not\([^)]*\)/g, '');
    return { tag: /^[a-z][\w-]*|^\*/.exec(rest)?.[0] ?? null, classes: [...rest.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]), nots,
      odd: /\[|:(?!not)/.test(rest), spec: [0, (rest.match(/\.|\[|:(?!:)/g) ?? []).length + nots.length, /^[a-z]/.test(rest) ? 1 : 0] };
  };
  const subjects = new Set(rules(css).flatMap((r) => r.sels.map((s) => parse(compounds(s).at(-1)).classes)).flat());
  const fits = (p, el) => !p.odd && (!p.tag || p.tag === '*' || p.tag === el.tag) && p.classes.every((c) => el.classes.includes(c)) && !p.nots.some((c) => el.classes.includes(c));
  const matches = (parts, el, ancestors) => {
    if (!fits(parse(parts.at(-1)), el)) return false;
    if (parts.length === 1) return true;
    const comb = parts.at(-2);
    if (comb === '>') return ancestors.length > 0 && matches(parts.slice(0, -2), ancestors.at(-1), ancestors.slice(0, -1));
    if (comb === '+' || comb === '~') return false;
    return ancestors.some((a, i) => matches(parts.slice(0, -1), a, ancestors.slice(0, i)));
  };
  const specOf = (sel) => compounds(sel).filter((c) => !/^[>+~]$/.test(c)).map((c) => parse(c).spec).reduce((a, s) => a.map((v, i) => v + s[i]), [0, 0, 0]);
  const desktop = rules(css.split('@media')[0]);
  const style = (el, ancestors = []) => {
    const hit = desktop.flatMap((r) => r.sels.filter((s) => matches(compounds(s), el, ancestors)).map((s) => ({ spec: specOf(s), order: r.order, body: r.body })));
    hit.sort((a, b) => a.spec[0] - b.spec[0] || a.spec[1] - b.spec[1] || a.spec[2] - b.spec[2] || a.order - b.order);
    const out = {};
    for (const x of hit) for (const d of x.body.split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
    return out;
  };
  return { subjects, style };
}

const DS = 'bigbenjoman__desk-skills';
const REPOS = [
  { slug: DS, gh: 'bigbenjoman/desk-skills', levers: '`preflight`' },
  { slug: 'acme__ai-agents', gh: 'acme/ai-agents', levers: '`none`' },
  { slug: 'acme__studia-web', gh: 'acme/studia-web', levers: null },
];
const config = (gh, levers) => `# desk config

## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`${gh}\` |
${levers == null ? '' : `
## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Phase 0 levers | \`none\` | ${levers} |
`}`;
const BASELINE = `PHASE 0 BASELINE: bigbenjoman__desk-skills, the 7 day(s) from 2026-11-06T15:23:07.463Z to 2026-11-13T15:23:07.463Z. Read-only: nothing is fetched, reset, checked out or written.

total (red CI counts every failed run in the repo, not only batch branches):
  tickets with work or a merge in the window: 36, accepted (PR merged): 24
  per accepted ticket: 38,881,286 input tokens · 174,824 output tokens · $17.52 API-equivalent, over 24 of 24
  fix tries per accepted ticket: 0.13 (3 made by accepted tickets)
  permission denials by command: 374 in all: cd 36 · grep 31
  levers on: none (114 start(s)) · not recorded (24 start(s))
`;

function machine({ repos = REPOS, files = {}, now }) {
  const base = scratch('levers-page-');
  const configRoot = join(base, 'config');
  const root = join(base, 'autopilot');
  for (const r of repos) {
    w(join(configRoot, 'repos', r.slug, 'config.md'), config(r.gh, r.levers));
    const sup = join(root, r.slug, 'supervisor.json');
    w(sup, '{}\n');
    utimesSync(sup, new Date(now - MIN), new Date(now - MIN));
  }
  w(join(root, DS, 'phase0-baseline-2026-11-13.txt'), BASELINE);
  for (const [p, body] of Object.entries(files)) w(join(root, p), body);
  return { root, configRoot, base };
}

// Today: no repo on auto, preflight pinned by hand in desk-skills, nothing evaluated.
const NOW1 = Date.parse('2026-11-13T14:32:00.000Z');
const today = V.buildView({ ...machine({ now: NOW1 }), now: NOW1, tz: 'UTC', generatedAt: NOW1 });

// Six weeks in: every repo on auto, desk recording since 6 Nov, three levers kept, two testing, codex
// waiting on a decision.
const NOW2 = Date.parse('2026-12-29T08:07:00.000Z');
const iso2 = (ms) => new Date(ms).toISOString();
const START = Date.parse('2026-11-06T10:00:00.000Z');
const rows = Array.from({ length: 53 }, (_, i) => ({
  slug: DS, batch: null, key: `DS-${i + 1}`, admitted_at: iso2(START + i * DAY), merged_at: iso2(START + i * DAY + HOUR),
  cost: 17.4 - i * 0.015, cost_complete: true, input: 38_000_000 - i * 80_000, output: 150_000, starts: 4, denials: Math.max(1, 12 - Math.floor(i / 5)), fix_tries: i % 7 === 0 ? 1 : 0,
}));
const ev = (lever, o) => ({
  v: 1, eval_id: `evl_${lever}`, at: iso2(NOW2 - 2 * HOUR), repo: DS, lever, state: o.state, arm_share_7d: 0.5,
  n: { on: o.on, off: o.off }, min_n: o.min ?? 30, max_n: 150,
  mechanism: o.mechanism ?? { metric: 'm', unit: 'ratio', min_benefit: -0.25, est: -0.42, lo90: -0.55, hi90: -0.33, scope: 'repo' },
  cost: { ratio: 0.96, lo90: 0.9, hi90: 1.01, margin: 1.05, usd_per_admitted: { on: 16.8, off: 17.5 } },
  guardrails: o.guardrails ?? [{ name: 'fix_tries_ratio', est: 1.02, lo90: 0.8, hi90: 1.2, margin: 1.25, p_worse: 0.1 }],
  decision: 'hold', reason_code: 'adopt_all_conditions',
});
const evals = [
  ev('preflight', { state: 'adopted', on: 40, off: 38 }), ev('wrappers', { state: 'adopted', on: 41, off: 40 }), ev('memory', { state: 'adopted', on: 36, off: 35 }),
  ev('failure-class', { state: 'trial', on: 19, off: 22, mechanism: { metric: 'm', unit: 'ratio', min_benefit: null, est: -0.1, lo90: -0.4, hi90: 0.2 } }),
  ev('review-reuse', { state: 'trial', on: 11, off: 12, min: 40 }),
];
const log = [
  { v: 1, id: 'l1', at: '2026-11-17T08:00:00.000Z', repo: DS, lever: 'preflight', kind: 'transition', from: 'off', to: 'trial', actor: 'controller', reason_code: 'row_change' },
  { v: 1, id: 'l2', at: '2026-12-09T08:02:00.000Z', repo: DS, lever: 'preflight', kind: 'transition', from: 'trial', to: 'adopted', actor: 'controller', reason_code: 'adopt_all_conditions',
    reason: 'Spend on start-up checks fell 42% across 64 tickets.', eval_id: 'evl_preflight', evidence_file: '/x/levers-evidence/evl_preflight.jsonl', desk_commit_range: 'abc1234..def5678' },
  { v: 1, id: 'l3', at: '2026-12-02T08:04:00.000Z', repo: DS, lever: 'wrappers', kind: 'transition', from: 'trial', to: 'adopted', actor: 'controller', reason_code: 'adopt_all_conditions', eval_id: 'evl_wrappers' },
  { v: 1, id: 'l4', at: '2026-12-20T09:00:00.000Z', repo: DS, lever: 'codex', kind: 'needs_you', actor: 'controller', reason_code: 'own_step_error', reason: 'codex turned off twice' },
];
const autoRepos = REPOS.map((r) => ({ ...r, levers: '`auto`' }));
const six = V.buildView({
  ...machine({ repos: autoRepos, now: NOW2, files: { [`${DS}/lever-evals.jsonl`]: jsonl(evals), [`${DS}/levers.jsonl`]: jsonl(log), [`${DS}/levers-evidence/evl_1.jsonl`]: jsonl(rows) } }),
  now: NOW2, tz: 'UTC', generatedAt: NOW2,
});

const hToday = P.renderPage(today);
const hSix = P.renderPage(six);

// AC1: nothing on the page reaches the network.
for (const [name, h, v] of [['today', hToday, today], ['six weeks', hSix, six]]) {
  t(`AC1 ${name}: no URL`, /\b(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(h), false);
  t(`AC1 ${name}: no src=`, /\bsrc\s*=/i.test(h), false);
  t(`AC1 ${name}: no fetch or XHR`, /\bfetch\b|XMLHttpRequest|import\(/.test(h), false);
  t(`AC1 ${name}: no link, @import or url()`, /<link\b|@import|url\(/i.test(h), false);
  t(`AC1 ${name}: a CSP that allows no network source`, h.includes("default-src 'none'"), true);
  t(`AC1 ${name}: view.json is inlined`, JSON.parse(h.split('<script type="application/json" id="levers-view">')[1].split('</script>')[0]).generated_at, v.generated_at);
}

// AC2 and AC3: the page's age, with a fixed clock.
{
  const at = '2026-11-13T08:12:00.000Z';
  const ms = Date.parse(at);
  t('AC2 59 minutes is fresh', P.pageAge(at, ms + 59 * MIN).state, 'fresh');
  t('AC2 just over an hour is stale', P.pageAge(at, ms + HOUR + 1000).state, 'stale');
  t('AC2 three hours, in words', P.pageAge(at, ms + 3 * HOUR).words, '3 hours ago');
  t('AC3 26 hours is still stale', P.pageAge(at, ms + 26 * HOUR).state, 'stale');
  t('AC3 just past 26 hours is out of date', P.pageAge(at, ms + 26 * HOUR + 1000).state, 'old');
  t('fresh: no banner', P.bannerHtml(P.pageAge(at, ms + 2 * MIN), 'x'), '');
  const stale = P.renderPage({ ...today, generated_at: at }, { now: ms + 3 * HOUR });
  t('AC2 the banner states its age', stale.includes('Updated 3 hours ago</span>'), true);
  t('AC2 and that the supervisor may have stopped', stale.includes('The supervisor may have stopped'), true);
  t('AC2 the page is not desaturated', stale.includes('<body data-age="stale">'), true);
  const old = P.renderPage({ ...today, generated_at: at }, { now: ms + 30 * HOUR });
  t('AC3 the banner shows', old.includes('Updated 30 hours ago: these numbers are out of date'), true);
  t('AC3 naming when it was built', old.includes('Nothing has rebuilt this page since Fri 13 Nov, 08:12'), true);
  t('AC3 the page is marked out of date', old.includes('<body data-age="old">'), true);
  t('AC3 which desaturates everything under the banner', /body\[data-age=old\] #page-body\{filter:grayscale\(1\)/.test(old), true);
  t('AC3 the banner sits outside the desaturated body', old.indexOf('id="age-banner"') < old.indexOf('<main id="page-body">'), true);
}

// The page's own script, run as a browser would when the page is opened at `openedAt`: what it leaves
// on the body, the banner and the age words.
function openAt(html, openedAt) {
  const script = html.split('<script>').pop().split('</script>')[0];
  const json = html.split('<script type="application/json" id="levers-view">')[1].split('</script>')[0];
  const since = /id="age-banner" data-since="([^"]*)"/.exec(html)[1];
  const el = { 'levers-view': { textContent: json }, 'age-banner': { innerHTML: '', getAttribute: () => since }, 'age-words': { textContent: '' } };
  const body = { attrs: {}, setAttribute(k, val) { this.attrs[k] = val; } };
  class FixedDate extends Date { static now() { return openedAt; } }
  const document = { getElementById: (id) => el[id], body, querySelectorAll: () => [] };
  vm.runInNewContext(script, { document, Date: FixedDate, JSON, Math, Number, Array, String, setInterval: () => 0 });
  return { age: body.attrs['data-age'], banner: el['age-banner'].innerHTML, words: el['age-words'].textContent };
}
{
  const at = '2026-11-13T08:12:00.000Z';
  const ms = Date.parse(at);
  const built = P.renderPage({ ...today, generated_at: at });
  const fresh = openAt(built, ms + 2 * MIN);
  t('opened 2 minutes after the build: fresh, no banner', `${fresh.age}|${fresh.banner}|${fresh.words}`, 'fresh||2 min ago');
  const stale = openAt(built, ms + 3 * HOUR);
  t('opened 3 hours after: stale', stale.age, 'stale');
  t('opened 3 hours after: the banner says so', stale.banner.includes('Updated 3 hours ago</span>') && stale.banner.includes('The supervisor may have stopped'), true);
  const old = openAt(built, ms + 30 * HOUR);
  t('opened 30 hours after: out of date', old.age, 'old');
  t('opened 30 hours after: the banner names the build', old.banner.includes('Updated 30 hours ago: these numbers are out of date') && old.banner.includes('since Fri 13 Nov, 08:12'), true);
  t('opened 30 hours after: the age words', old.words, '30 hours ago');
}

const section = (h, id) => { const i = h.indexOf(`aria-labelledby="${id}"`); return i < 0 ? '' : h.slice(i, h.indexOf('</section>', i)); };
const tilesOf = (h) => [...h.split('aria-label="Headline numbers"')[1].split('</section>')[0].matchAll(/<h3 class="muted">([^<]*)<\/h3><span class="num tile-v">([^<]*)<\/span>/g)].map((m) => `${m[1]}=${m[2]}`);

// AC4: the Today board.
{
  t('AC4 the status sentence', /<b>Not started yet\.<\/b> desk has recorded what a ticket costs with no levers on\./.test(hToday), true);
  t('AC4 four starting-point tiles', j(tilesOf(hToday)), j(['Cost per ticket=$17.52', 'Tokens per ticket=38.9M', 'Fix tries per ticket=0.13', 'Permission prompts=374']));
  t('AC4 each a starting point', count(hToday, />Starting point</g), 4);
  t('AC4 the cost tile names the window', hToday.includes('Before levers · 24 tickets, 6–13 Nov'), true);
  const tr = section(hToday, 'tr-h');
  t('AC4 awaiting data on all four trends', count(tr, />Awaiting data</g), 4);
  t('AC4 no chart yet', tr.includes('<svg'), false);
  const lev = section(hToday, 'lev-h');
  t('AC4 the lever table has What happens next', lev.includes('>What happens next</th>'), true);
  t('AC4 one row per lever', count(lev, /<tr data-lever=/g), 12);
  // Each row reads across repos (data-all) and, for the repo filter, in each repo it has a cell in.
  t('AC4 the ledger, never trialled, says it is on only where named (DS-893)', /<tr data-lever="ledger"[^>]*>.*?<div data-all>Not trialled: on only where a repo’s levers row names it\./.test(lev), true);
  t('question handling is on trial: it waits for a repo set to auto, like the others', /<tr data-lever="question-handling"[^>]*>.*?<div data-all>Testing starts (once|when) a repo is set to auto\./.test(lev), true);
  t('AC4 preflight is on by hand, first', /<tr data-lever="preflight"[^>]*>.*?On by hand/.test(lev) && lev.indexOf('data-lever="preflight"') < lev.indexOf('data-lever="wrappers"'), true);
  t('AC4 its next step', lev.includes('Pinned by hand in desk-skills, so this is a before-and-after, not a test.'), true);
  t('AC4 the others, quality-risk ones included, are off until a repo is on auto', count(lev, /<div data-all>Testing starts (once|when) a repo is set to auto\./g), 9);
  t('AC4 the change list, as on any day', section(hToday, 'ch-h').includes('>Every change</h2>'), true);
  t('AC4 with nothing changed', section(hToday, 'ch-h').includes('Nothing has changed how desk works yet.'), true);
  t('AC4 How desk decides, before any test too', hToday.includes('<h2 id="how-h">How desk decides</h2>'), true);
}

// AC5: the Main board.
{
  t('AC5 the status sentence', /<b>Needs you\.<\/b> Last week a ticket cost <b>[\d.]+% less<\/b> than before levers, and nothing has got worse\. 3 kept, 2 still being tested, and <b class="amber">1 needs your decision<\/b>\./.test(hSix), true);
  t('AC5 four tiles', j(tilesOf(hSix).map((x) => x.split('=')[0])), j(['Cost per ticket', 'Tokens per ticket', 'Fix tries per ticket', 'Needs you']));
  t('AC5 the needs-you tile', tilesOf(hSix)[3], 'Needs you=1');
  t('AC5 four WBR cards', count(hSix, /<article class="card wbr"/g), 4);
  const lev = section(hSix, 'lev-h');
  t('AC5 Is each lever working?, one row per lever', count(lev, /<tr data-lever=/g), 12);
  t('AC5 with results and progress', lev.includes('>Result so far</th>') && lev.includes('>Progress to a decision</th>'), true);
  t('AC5 kept first, codex needing you after the tests', [...lev.matchAll(/<tr data-lever="([^"]+)"/g)].map((m) => m[1]).join(), 'preflight,wrappers,memory,failure-class,review-reuse,codex,effort,finder-model,question-handling,handoff-threshold,ledger,ledger-record');
  const ch = section(hSix, 'ch-h');
  t('AC5 Every change', ch.includes('>Every change</h2>'), true);
  t('AC5 its line', ch.includes('<p class="muted small sub">Newest first. Lever changes come from tests. Other changes can’t be tested, so each shows the tickets before and after it. Numbers match the lines on the charts.</p>'), true);
  t('AC5 newest first', [...ch.matchAll(/class="muted num small when">([^<]*)</g)].map((m) => m[1]).join('|'), '9 Dec, 08:02|2 Dec, 08:04|17 Nov, 08:00');
  t('AC5 How desk decides', hSix.includes('<h2 id="how-h">How desk decides</h2>') && hSix.includes('Once 30 tickets on each side'), true);
}

// The headline tiles: the figure since desk started recording, its window and ticket count, with last
// week's and yesterday's beneath it, each with its own count.
{
  const tileOf = (h, label) => h.split('aria-label="Headline numbers"')[1].split('</section>')[0].split(`<h3 class="muted">${label}</h3>`)[1].split('</article>')[0];
  const c = tileOf(hSix, 'Cost per ticket');
  t('tiles: cost shows the figure to date', tilesOf(hSix)[0], 'Cost per ticket=$17.01');
  t('tiles: labelled with its window and ticket count', c.includes('Since 6 Nov · 53 tickets'), true);
  t('tiles: last week and yesterday beneath, each with its count', c.includes('Last week $16.68, 7 tickets · Yesterday $16.62, 1 ticket'), true);
  t('tiles: no Was line', hSix.includes('>Was $'), false);
  const over = structuredClone(six);
  over.panels.trends.metrics.fixes.callouts.to_date = 0.2;
  const f = tileOf(P.renderPage(over), 'Fix tries per ticket');
  t('tiles: fix tries over the 0.16 limit turn amber', f.includes('<span class="tile-s" style="color:#B45309"><span class="dot" style="background:#D97706"></span>Over the 0.16 limit</span>'), true);
  t('tiles: fix tries under it do not', tileOf(hSix, 'Fix tries per ticket').includes('Over the'), false);
}

const cards = hSix.split('<article class="card wbr"').slice(1).map((c) => c.split('</article>')[0]);
const chartOf = (c, view) => c.split(`<div class="chart" data-view="${view}"`)[1].split('<div class="legend">')[0];

// AC6: each metric is a WBR card.
{
  const want = {
    cost: ['Cost per Ticket', 'API-equivalent spend per merged ticket, by the day it merged, all repos'], tokens: ['Tokens per Ticket', 'Input tokens per merged ticket, by the day it merged'],
    prompts: ['Permission Prompts per Start', 'Times a worker was blocked asking to run a command, per start, by the day its ticket merged'],
    fixes: ['Fix Tries per Ticket', 'Per merged ticket, by the day it merged. Must stay under 0.16 for a lever to be kept'],
  };
  for (const [i, [key, [title, sub]]] of Object.entries(want).entries()) {
    const c = cards[i];
    t(`AC6 ${key}: title`, c.includes(`<h3>${title}</h3>`), true);
    t(`AC6 ${key}: one-line description`, c.includes(`<p class="muted wbr-sub">${sub}</p>`), true);
    t(`AC6 ${key}: a status dot with its label`, /<span class="rag" role="img" aria-label="(Green|Amber|Grey): [^"]+"/.test(c), true);
    t(`AC6 ${key}: the nine callouts`, [...c.matchAll(/class="callout-l">([^<]*)</g)].map((m) => m[1]).join(','), 'Yesterday,DoD%,Last Wk,WoW%,vs before,MTD,MoM%,To date,vs before');
    t(`AC6 ${key}: now in black`, chartOf(c, 'wbr').includes('class="now" points=') && chartOf(c, 'wbr').includes('stroke="#111827" stroke-width="2.5"'), true);
    t(`AC6 ${key}: before levers in grey`, chartOf(c, 'wbr').includes('class="base" points=') && c.includes('Before levers</span>'), true);
  }
  t('AC6 cost reads better than before', cards[0].includes('aria-label="Green: better than before levers"'), true);
}

const labels = (chart) => [...chart.matchAll(/<span(?: class="gap-note")? style="[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);
// AC7: the dual panel, 6 weeks by week on the left and 12 months by month on the right.
{
  const ch = chartOf(cards[0], 'wbr');
  const ls = labels(ch);
  t('AC7 six week labels', ls.filter((l) => /^WK \d+$/.test(l)).join(','), 'WK 47,WK 48,WK 49,WK 50,WK 51,WK 52');
  t('AC7 twelve month ticks', count(ch, /y2="290\.6" stroke="#6E7079"/g), 18);
  t('AC7 months labelled every other month, ending this one', ls.filter((l) => /^[A-Z]{3}$/.test(l)).join(','), 'FEB,APR,JUN,AUG,OCT,DEC');
  t('AC7 the left panel spans 8% to 48%, the right 54% to 91%', ch.includes('x1="56.0" y1="285.6" x2="336.0"') && ch.includes('x1="378.0" y1="285.6" x2="637.0"'), true);
  t('AC7 shown by default', /^>/.test(ch), true);
}

// AC8: Last 30 days, one point a day.
{
  for (const [i, c] of cards.entries()) {
    const d = chartOf(c, 'days');
    t(`AC8 card ${i + 1}: 30 days of ticks`, count(d, /y2="290\.6" stroke="#6E7079"/g), 30);
    t(`AC8 card ${i + 1}: a point for each day`, count(d, /<circle class="pt"/g), 30);
  }
  t('AC8 labelled by day', labels(chartOf(cards[0], 'days')).includes('28 Dec'), true);
  t('AC8 hidden until switched to', /^ hidden>/.test(chartOf(cards[0], 'days')), true);
  t('AC8 the switch', hSix.includes('<button type="button" data-show="days" aria-pressed="false">Last 30 days</button>'), true);
}

// AC9: no data before 6 Nov leaves a gap with a note, never a line at zero.
{
  const ch = chartOf(cards[0], 'wbr');
  const monthly = six.panels.trends.metrics.cost.monthly;
  t('AC9 the fixture has 10 empty months', monthly.filter((m) => m.value == null).length, 10);
  t('AC9 the note', labels(ch).includes('desk started recording on 6 Nov'), true);
  const weekly = six.panels.trends.metrics.cost.weekly.filter((p) => p.value != null).length;
  t('AC9 only recorded points are drawn', count(ch, /<circle class="pt"/g), weekly + 2);
  t('AC9 the two recorded months are one segment', count(ch, /class="now" points="[^"]*"/g), 2);
  t('AC9 no point sits on the axis', [...ch.matchAll(/<circle class="pt" cx="[^"]*" cy="([^"]*)"/g)].some((m) => m[1] === '285.6'), false);
  const notes = (h) => count(h, /class="gap-note"/g);
  t('AC9 the note once, over the 12-month panel only', notes(ch), 1);
  // Days with no tickets after desk started recording are a gap with no note.
  const quiet = structuredClone(six);
  for (const p of quiet.panels.trends.metrics.cost.daily.slice(0, 3)) p.value = null;
  const qc = P.renderPage(quiet).split('<article class="card wbr"')[1].split('</article>')[0];
  t('AC9 ticketless days after the first recorded day: a gap', count(chartOf(qc, 'days'), /<circle class="pt"/g), 27);
  t('AC9 with no recording note', notes(chartOf(qc, 'days')), 0);
  // One month before the first recorded day still gets the note.
  const feb = structuredClone(six);
  feb.panels.trends.metrics.cost.first_recorded = '2026-02-10';
  const fc = P.renderPage(feb).split('<article class="card wbr"')[1].split('</article>')[0];
  t('AC9 a single month before recording: the note', labels(chartOf(fc, 'wbr')).filter((l) => l === 'desk started recording on 10 Feb').length, 1);
}

// Chart labels: the recording note sits above the plot, clear of the baseline; each value label stays
// inside its panel, clear of the tick labels beside it; and with under 3 weekly points the trends open
// on the last 30 days.
{
  const spans = (ch) => [...ch.matchAll(/<span(?: class="(gap-note)")? style="left:([\d.]+)%;top:([\d.]+)%;transform:([^;]*);color:([^"]*)">([^<]*)<\/span>/g)]
    .map((m) => ({ note: !!m[1], left: Number(m[2]), top: Number(m[3]), tf: m[4], c: m[5], s: m[6] }));
  const ch = chartOf(cards[0], 'wbr');
  const note = spans(ch).find((x) => x.note);
  t('labels: the recording note sits above the top of the plot', note.top < 12 && note.tf.endsWith('-100%)'), true);
  // A 10px label is about 7 chart units a character wide; the panels span 8% to 48% and 54% to 91%.
  const width = (s) => (s.length * 7 / 700) * 100;
  const inside = (x, lo, hi) => /^translate\(0,(-100%|0)\)$/.test(x.tf) && x.left >= lo - 0.01 && x.left + width(x.s) <= hi + 0.01;
  const values = (c) => spans(c).filter((x) => x.c === '#111827');
  const vs = values(ch);
  t('labels: the weekly values stay inside the left panel', vs.filter((x) => x.left < 50).every((x) => inside(x, 8, 48)), true);
  t('labels: the monthly values stay inside the right panel, clear of its ticks', vs.filter((x) => x.left >= 50).every((x) => inside(x, 54, 91)), true);
  t('labels: the 30-day values stay inside their panel', values(chartOf(cards[0], 'days')).every((x) => inside(x, 8, 95)), true);
  // Two weeks in: under 3 weekly points.
  const early = structuredClone(six);
  for (const m of Object.values(early.panels.trends.metrics)) m.weekly = m.weekly.map((p, i) => (i < 4 ? { ...p, value: null } : p));
  const h = P.renderPage(early);
  const c0 = h.split('<article class="card wbr"')[1].split('</article>')[0];
  t('labels: under 3 weekly points the 30 days show by default', [/^ hidden>/.test(chartOf(c0, 'wbr')), /^>/.test(chartOf(c0, 'days'))].join(), 'true,true');
  t('labels: and its button is the pressed one', h.includes('<button type="button" data-show="days" aria-pressed="true">Last 30 days</button>'), true);
  t('labels: with its line of the heading', h.includes('<p class="muted small" data-view="wbr" hidden>') && h.includes('<p class="muted small" data-view="days">'), true);
  const sparkPts = (html) => /<svg viewBox="0 0 220 32"[^]*?<polyline points="([^"]*)"/.exec(html.split('aria-label="Headline numbers"')[1])[1].split(' ').filter(Boolean).length;
  t('labels: the tile sparkline follows the days too, rather than one weekly point', sparkPts(h) > 3, true);
  t('labels: and the weeks once there are 3', sparkPts(hSix), 6);
  // A dip: its label goes under the point, where the line into and out of it does not run.
  const dip = structuredClone(six);
  const dm = dip.panels.trends.metrics.cost;
  dm.daily = dm.daily.map((p, i) => ({ ...p, value: [17, 18, 12, 18][i % 4] }));
  const dd = spans(chartOf(P.renderPage(dip).split('<article class="card wbr"')[1].split('</article>')[0], 'days')).filter((x) => x.c === '#111827');
  t('labels: a dip is labelled under its point', dd.some((x) => x.s === '$12.00' && x.tf === 'translate(0,0)'), true);
  t('labels: a peak above it', dd.some((x) => x.s === '$18.00' && x.tf === 'translate(0,-100%)'), true);
}

// AC10: an effect with no verdict is grey, says too early, and has no direction word.
{
  const lev = section(hSix, 'lev-h');
  const fc = lev.split('<tr data-lever="failure-class"')[1].split('</tr>')[0];
  const res = /<span class="b result" data-verdict="none" style="color:#4B5563">([^<]*)<\/span>/.exec(fc);
  t('AC10 grey', !!res, true);
  t('AC10 its too-early label', res?.[1], 'Too early: 19 of 30');
  t('AC10 no direction word', /\b(lower|higher|better|worse|fewer|more|less)\b/i.test(res?.[1] ?? ''), false);
  t('AC10 its range and n are still shown', fc.includes('90% range −0.4 to 0.2 · n 19'), true);
  const pf = lev.split('<tr data-lever="preflight"')[1].split('</tr>')[0];
  t('AC10 a decided effect gets its direction', /data-verdict="better" style="color:#111827">42% lower preflight dollars per start</.test(pf), true);
  t('AC5 a kept lever: its cost and guardrails in plain words', pf.includes('<span class="muted tiny">Cost not worse than off, nothing worse</span>'), true);
  t('AC5 a kept lever: the day it was decided', pf.includes('>Decided 9 Dec</span>'), true);
  t('AC10 too early: no cost or guardrail words yet', fc.includes('nothing worse'), false);
  // A kept lever whose whole cost interval is under 1.00 saves money.
  const saving = structuredClone(six);
  saving.panels.board.levers.find((l) => l.lever === 'wrappers').cells.find((c) => c.sample).cost.saving_usd = { lo: 0.18, hi: 1.75 };
  const wr = section(P.renderPage(saving), 'lev-h').split('<tr data-lever="wrappers"')[1].split('</tr>')[0];
  t('AC5 a saving, per ticket', wr.includes('Cost not worse than off, saves $0.18–$1.75 a ticket, nothing worse'), true);
}

// AC11: an expanded change carries its reason, arms, intervals, guardrails, commits and evidence file.
{
  const kept = section(hSix, 'ch-h').split(/<details class="change"[^>]*>/)[1].split('</details>')[0];
  const dl = Object.fromEntries([...kept.matchAll(/<dt>([^<]*)<\/dt><dd>(.*?)<\/dd>/g)].map((m) => [m[1], m[2].replace(/<[^>]+>/g, '')]));
  t('AC11 the reason', dl.Reason, 'Every adopt condition held adopt_all_conditions');
  t('AC11 tickets per arm', dl['Tickets per arm'], '40 on, 38 off');
  t('AC11 the mechanism interval', dl.Mechanism, 'Better by at least the minimum, 90% range −0.55 to −0.33, estimate −0.42');
  t('AC11 the cost interval', dl.Cost, 'Not worse than off, 90% range 0.9 to 1.01, margin 1.05');
  t('AC11 each guardrail', dl.Guardrails, 'fix tries ratio: ok, 90% range 0.8 to 1.2, margin 1.25');
  t('AC11 the commit range', dl['Commit range'], 'abc1234..def5678');
  t('AC11 the evidence file', dl['Evidence file'], '/x/levers-evidence/evl_preflight.jsonl');
  // A lever with more than two arms names its lead value and its baseline in place of on and off.
  const valuedEvals = evals.map((e) => (e.lever === 'preflight' ? { ...e, value: 'batched', baseline: 'one-at-a-time' } : e));
  const valuedView = V.buildView({
    ...machine({ repos: autoRepos, now: NOW2, files: { [`${DS}/lever-evals.jsonl`]: jsonl(valuedEvals), [`${DS}/levers.jsonl`]: jsonl(log), [`${DS}/levers-evidence/evl_1.jsonl`]: jsonl(rows) } }),
    now: NOW2, tz: 'UTC', generatedAt: NOW2,
  });
  const vchange = valuedView.panels.changes.all.find((c) => c.lever === 'preflight' && c.evidence);
  t('a valued lever: the view names the arms its counts are of, its value and baseline', JSON.stringify([vchange?.evidence?.n?.arms, vchange?.evidence?.n?.on, vchange?.evidence?.n?.off]), '[["batched","one-at-a-time"],40,38]');
  t('AC11 a change citing no evaluation says so', section(hSix, 'ch-h').split(/<details class="change"[^>]*>/)[3].includes('<dt>Tickets per arm</dt><dd><span class="muted">not recorded</span>'), true);
}


// Question handling's per-arm ask report: in the view from the latest evaluation, and on the page.
{
  const arm = (o) => ({ tickets: 30, asks: 31, steps: { raise: { tokens_per_ticket: 410, usd_per_ticket: 0.41, tickets: 30 }, present: { tokens_per_ticket: 0, usd_per_ticket: 0, tickets: 30 }, act: { tokens_per_ticket: 600, usd_per_ticket: 0.6, tickets: 28 } },
    pushes_per_ticket: 0, digests_per_ticket: 1, defaulted_share: 0.25, median_latency_s: 5400, ...o });
  const report = { batched: arm({}), 'one-at-a-time': arm({ pushes_per_ticket: 1, digests_per_ticket: 0, defaulted_share: 0, median_latency_s: 600 }) };
  const qh = { ...ev('question-handling', { state: 'trial', on: 30, off: 30 }), ask_report: report };
  const asked = V.buildView({ ...machine({ repos: autoRepos, now: NOW2, files: { [`${DS}/lever-evals.jsonl`]: jsonl([...evals, qh]) } }), now: NOW2, tz: 'UTC', generatedAt: NOW2 });
  const panel = asked.panels.asks?.repos ?? [];
  t('the view carries each repo\'s latest per-arm ask report', j(panel.map((r) => [r.name, r.lever, Object.keys(r.arms)])), j([['desk-skills', 'question-handling', ['batched', 'one-at-a-time']]]));
  t('and no other lever has one', j((six.panels.asks?.repos ?? []).length), '0');
  const sec = section(P.renderPage(asked), 'asks-h');
  const cells = (...xs) => xs.map((x) => `<td class="td n">${x}</td>`).join('');
  const rowOf = (a) => sec.split(`<th scope="row" class="td">${a}</th>`)[1]?.split('</tr>')[0] ?? '';
  t('the page shows a row per arm', ['batched', 'one-at-a-time'].every((a) => rowOf(a)), true);
  t('each with dollars and tokens per ticket by step', rowOf('batched').includes('<td class="td n">$0.41 (410)</td><td class="td n">$0.00 (0)</td><td class="td n">$0.60 (600)</td>'), true);
  t('pushes and digests per ticket, the share defaulted and the median to an answer', [rowOf('batched').includes(cells('0', '1', '25%', '1.5h')), rowOf('one-at-a-time').includes(cells('1', '0', '0%', '10m'))].join(' '), 'true true');
  t('with no ask report, the page has no such section', section(hSix, 'asks-h'), '');
}

// DS-1037 AC5: the handoff threshold's per-value report: in the view from the latest evaluation, and on
// the page, each value's dollars and handoffs per ticket against the baseline.
{
  const report = { config: { tickets: 30, usd_per_ticket: 4, handoffs_per_ticket: 2 }, 20: { tickets: 30, usd_per_ticket: 3, handoffs_per_ticket: 3.5 },
    30: { tickets: 30, usd_per_ticket: 3.6, handoffs_per_ticket: 2.5 }, 45: { tickets: 30, usd_per_ticket: 4.4, handoffs_per_ticket: 1 } };
  const ht = { ...ev('handoff-threshold', { state: 'trial', on: 30, off: 30 }), handoff_report: report };
  const built = V.buildView({ ...machine({ repos: autoRepos, now: NOW2, files: { [`${DS}/lever-evals.jsonl`]: jsonl([...evals, ht]) } }), now: NOW2, tz: 'UTC', generatedAt: NOW2 });
  const panel = built.panels.handoffs?.repos ?? [];
  t('AC5 the view carries each repo\'s latest per-value handoff report, with its baseline', j(panel.map((r) => [r.name, r.lever, r.baseline, Object.keys(r.arms).sort()])), j([['desk-skills', 'handoff-threshold', 'config', ['20', '30', '45', 'config']]]));
  t('and no other lever has one', j((six.panels.handoffs?.repos ?? []).length), '0');
  const sec = section(P.renderPage(built), 'handoffs-h');
  const rowOf = (a) => sec.split(`<th scope="row" class="td">${a}</th>`)[1]?.split('</tr>')[0] ?? '';
  const cells = (...xs) => xs.map((x) => `<td class="td n">${x}</td>`).join('');
  t('AC5 the page shows the baseline first, then each value', [...sec.matchAll(/<th scope="row" class="td">([^<]+)<\/th>/g)].map((m) => m[1]).join(','), 'config (baseline),20%,30%,45%');
  t('AC5 each row has its tickets, dollars per ticket, against the baseline, and handoffs per ticket',
    [rowOf('config (baseline)').includes(cells('30', '$4.00', '—', '2')), rowOf('20%').includes(cells('30', '$3.00', '−25%', '3.5')), rowOf('45%').includes(cells('30', '$4.40', '+10%', '1'))].join(' '), 'true true true');
  t('with no handoff report, the page has no such section', section(hSix, 'handoffs-h'), '');
}

// The merge-time, learned-bar, time-parked and asks sections, in the house style of the lever table:
// one card table per section, each repo a group header row, numbers right-aligned, and every class the
// page puts on a section or table part has a CSS rule.
{
  const arm = { tickets: 30, steps: { raise: { tokens_per_ticket: 410, usd_per_ticket: 0.41 } }, pushes_per_ticket: 0, digests_per_ticket: 1, defaulted_share: 0.25, median_latency_s: 5400 };
  const full = structuredClone(six);
  full.panels.merge_stages = { repos: [{ name: 'desk-skills', prs: 4, stages: { desk: { n: 4, median: 96, p75: 108 }, merge: { n: 3, median: 5, p75: 9 } }, outage: 1,
    learned: { since: '2026-11-24T00:00:00.000Z', before: { prs: 2, rereviews: 1.5, approval: 120 }, after: { prs: 2, rereviews: 0.5, approval: 40 } } }] };
  const usage = { cause: 'usage', hours: 15, tickets: 2, link: null }, lock = { cause: 'lock', hours: 0.5, tickets: 1, link: null }, hold = { cause: 'park: hold', hours: 4.5, tickets: 2, link: null };
  full.panels.stuck_time = { repos: [{ name: 'desk-skills', weeks: [{ week: '2026-W52', hours: 20, tickets: 5, causes: [usage, hold, lock],
    groups: { stalled: { hours: 15.5, tickets: 3, causes: [usage, lock] }, held: { hours: 4.5, tickets: 2, causes: [hold] } } },
  { week: '2026-W51', hours: 0, tickets: 0, causes: [], groups: { stalled: { hours: 0, tickets: 0, causes: [] }, held: { hours: 0, tickets: 0, causes: [] } } }] }] };
  full.panels.asks = { repos: [{ name: 'desk-skills', lever: 'question-handling', at: '2026-12-28T06:00:00.000Z', state: 'trial', arms: { batched: arm, 'one-at-a-time': arm } }] };
  const h = P.renderPage(full);
  const css = h.split('<style>')[1].split('</style>')[0];
  const check = cssChecks(css);
  const used = new Set([...h.matchAll(/<(?:section|table|thead|tbody|tr|th|td)\b[^>]*\bclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
  t('styles: every class on a section or table part is the subject of a CSS rule', j([...used].filter((c) => !check.subjects.has(c))), '[]');
  // What the desktop rules give a numeric header and body cell of a data table, and its group row.
  const table = { tag: 'table', classes: ['levtable', 'data'] };
  const cell = (tag, classes) => check.style({ tag, classes }, [table, { tag: 'tbody', classes: [] }, { tag: 'tr', classes: [] }]);
  const numTh = cell('th', ['th', 'n']);
  const numTd = cell('td', ['td', 'n']);
  t('styles: a numeric header cell is right-aligned with tabular figures', `${numTh['text-align']} ${numTh['font-variant-numeric']}`, 'right tabular-nums');
  t('styles: a numeric body cell too', `${numTd['text-align']} ${numTd['font-variant-numeric']}`, 'right tabular-nums');
  t('styles: a row header stays left-aligned', cell('th', ['td'])['text-align'], 'left');
  t('styles: a group row has its own background', cell('th', ['td', 'grp']).background, '#F9FAFB');
  // The checks catch a page whose table rules are gone.
  const bare = cssChecks(css.replace(/\.levtable \.(n|grp)\{[^}]*\}/g, ''));
  t('styles: without the table rules the checks fail', j([bare.subjects.has('grp'), bare.style({ tag: 'td', classes: ['td', 'n'] }, [table])['text-align'] ?? null]), '[false,null]');
  for (const id of ['ms-h', 'lr-h', 'st-h', 'asks-h']) {
    const sec = h.slice(h.lastIndexOf('<section', h.indexOf(`aria-labelledby="${id}"`)), h.indexOf('</section>', h.indexOf(`aria-labelledby="${id}"`)));
    // Merge time by stage and time parked by cause start closed: the head is the fold's summary, and the
    // intro opens with the table.
    const folded = ['ms-h', 'st-h'].includes(id);
    t(`styles ${id}: a card like the lever table`, /^<section aria-labelledby="[^"]+" class="card levers/.test(sec) && sec.includes(folded ? '<details class="fold"><summary class="levers-head fold-sum">' : '<div class="levers-head">'), true);
    t(`styles ${id}: one table`, count(sec, /<table /g), 1);
    t(`styles ${id}: a muted intro line`, (folded ? /<p class="muted small fold-intro">[^<]+<\/p>/ : /<h2 id="[^"]+">[^<]+<\/h2><p class="muted small">[^<]+<\/p>/).test(sec), true);
    t(`styles ${id}: the repo as a group header row`, /<tr class="grp"[^>]*><th scope="colgroup" colspan="\d+" class="td grp">desk-skills/.test(sec), true);
  }
  const ms = section(h, 'ms-h');
  t('styles: numbers right-aligned', ms.includes('<tr><th scope="row" class="td">desk review</th><td class="td n">1.6h</td><td class="td n">1.8h</td><td class="td n">4</td></tr>'), true);
  t('styles: their headers too', ms.includes('<th scope="col" class="th n">Median</th>'), true);
  t('styles: the outage note sits under its repo', ms.includes('1 external review wait inside a gate reviewer outage left out of the medians.'), true);
  const st = section(h, 'st-h');
  t('styles: no Tracking issue column when no cause has one', st.includes('Tracking issue'), false);
  t('styles: a week with nothing parked has no group', st.includes('2026-W51'), false);
  const linked = structuredClone(full);
  linked.panels.stuck_time.repos[0].weeks[0].causes[0].link = { ref: '#1377', url: 'https://example.invalid/1377' };
  t('styles: the Tracking issue column shows once a cause has one', section(P.renderPage(linked), 'st-h').includes('<th scope="col" class="th">Tracking issue</th>'), true);
}

// The change list words each change from its reason code, never the raw reason with its paths; an
// evidence_incomplete event recorded once per lever reads as one, naming the levers, and its details
// name the tickets and files not recorded.
{
  const st = '/home/x/.desk-autopilot/bigbenjoman__desk-skills';
  const missing = [`${st}/post-merge.jsonl (its latest scan is incomplete)`, `${st}/workers/DS-261.runs.jsonl`];
  const inc = (lever, i) => ({ v: 1, id: `inc-${lever}`, at: iso2(Date.parse('2026-12-22T00:00:29.000Z') + i), repo: DS, lever, kind: 'evidence_incomplete', actor: 'levers-auto', reason_code: 'evidence_incomplete', missing,
    reason: `${lever} in desk-skills: nothing adopts while outcome files are missing: ${missing.join(', ')}` });
  const v = V.buildView({
    ...machine({ repos: autoRepos, now: NOW2, files: { [`${DS}/lever-evals.jsonl`]: jsonl(evals), [`${DS}/levers.jsonl`]: jsonl([...log, inc('wrappers', 0), inc('memory', 1), inc('codex', 2)]), [`${DS}/levers-evidence/evl_1.jsonl`]: jsonl(rows) } }),
    now: NOW2, tz: 'UTC', generatedAt: NOW2,
  });
  const ch = section(P.renderPage(v), 'ch-h');
  const incs = ch.split(/<details class="change"[^>]*>/).slice(1).filter((d) => d.includes('was incomplete'));
  t('change log: one event for the three levers', incs.length, 1);
  t('change log: naming them', incs[0]?.includes('Evidence for codex, memory and wrappers in desk-skills was incomplete'), true);
  t('change log: worded from its reason code', incs[0]?.includes('<span class="muted small">Some outcomes the evaluation reads weren’t recorded</span>'), true);
  t('change log: no absolute path anywhere in it', ch.includes('/home/x'), false);
  t('change log: the details name the tickets and files', incs[0]?.includes('<dt>Not recorded</dt><dd><ul class="guards"><li>A review round’s findings weren’t recorded: DS-261</li><li>The post-merge watch’s latest scan didn’t finish: post-merge.jsonl</li></ul></dd>'), true);
}

// A reason a person typed, or one carrying a value (a row's new reading, an arm set by hand), is
// shown as written: only the machine-written reasons of incomplete evidence and code changes give way
// to their reason code's wording.
{
  const at = (h) => iso2(Date.parse('2026-12-23T09:00:00.000Z') + h * HOUR);
  const human = [
    { v: 1, id: 'rc', at: at(0), repo: DS, kind: 'row_change', actor: 'ben', reason_code: 'row_change', reason: 'config §3b "Phase 0 levers" now reads `auto`', before: 'none', after: 'auto' },
    { v: 1, id: 'fz', at: at(1), repo: DS, kind: 'freeze', actor: 'ben', reason_code: 'freeze', reason: 'holiday week, nobody to answer' },
    { v: 1, id: 'ov', at: at(2), repo: DS, lever: 'question-handling', kind: 'override', actor: 'ben', reason_code: 'ben_override', to: 'one-at-a-time', reason: 'set to one-at-a-time by hand to see the pushes' },
  ];
  const v = V.buildView({
    ...machine({ repos: autoRepos, now: NOW2, files: { [`${DS}/lever-evals.jsonl`]: jsonl(evals), [`${DS}/levers.jsonl`]: jsonl([...log, ...human]), [`${DS}/levers-evidence/evl_1.jsonl`]: jsonl(rows) } }),
    now: NOW2, tz: 'UTC', generatedAt: NOW2,
  });
  const ch = section(P.renderPage(v), 'ch-h');
  const summaryOf = (what) => ch.split(/<details class="change"[^>]*>/).slice(1).find((d) => d.includes(what))?.split('</summary>')[0] ?? '';
  t('change log: a row change names the reading before and after', summaryOf('The levers row in desk-skills changed').includes('changed from none to auto'), true);
  t('change log: and shows its reason as written', summaryOf('The levers row in desk-skills changed').includes('<span class="muted small">Config §3b &quot;Phase 0 levers&quot; now reads `auto`</span>'), true);
  t('change log: a freeze shows the reason typed for it', summaryOf('Trials frozen').includes('<span class="muted small">Holiday week, nobody to answer</span>'), true);
  t('change log: an arm set by hand shows its reason', summaryOf('set question-handling to one-at-a-time').includes('<span class="muted small">Set to one-at-a-time by hand to see the pushes</span>'), true);
}

// Text from the view is escaped, and view.json cannot close its script element.
{
  const evil = structuredClone(six);
  evil.panels.changes.all[0].reason = '</script><img onerror=x>';
  const h = P.renderPage(evil);
  t('escaped in the markup', h.includes('&lt;/script&gt;&lt;img onerror=x&gt;'), true);
  t('escaped in the inline JSON', h.includes('\\u003c/script>\\u003cimg'), true);
}

// render writes index.html beside view.json.
{
  const dir = scratch('levers-page-out-');
  w(join(dir, 'view.json'), JSON.stringify(today));
  const { file } = V.render({ dir });
  t('render: index.html beside view.json', file, join(dir, 'index.html'));
  t('render: the page', readFileSync(file, 'utf8'), hToday);
  let msg = '';
  try { V.render({ dir: join(dir, 'none') }); } catch (e) { msg = e.message; }
  t('render: no view.json says to build first', /no view\.json at .*run `levers-view\.mjs build` first/.test(msg), true);
}

// DS-1000 AC4: once results show, a repo the lever is not tested in still says why in its cell.
{
  const v = structuredClone(six);
  v.panels.board.levers.find((l) => l.lever === 'finder-model').cells = [{ repo: 'desk-skills', state: 'ineligible', status: 'finders already on sonnet', why: 'both arms would be the same', note: 'not tested in desk-skills: both arms would be the same' }];
  const h = P.renderPage(v);
  t('DS-1000 AC4 the results layout names the reason as a short status, its rationale on hover', h.includes('<span class="repo" data-repo="desk-skills" title="both arms would be the same"><span class="dot dot-sm" style="background:#9CA3AF"></span><span>desk-skills: not tested, finders already on sonnet</span>'), true);
  t('DS-1000 AC4 not the rationale as the reason', h.includes('not tested here, as'), false);
}

// A lever waiting on you, from the 2026-11-26 finder-model state: on trial in desk-skills and evaluated
// at 03:00, then reverted at 05:30 when its own step failed on DS-1012, which raised a needs-you item.
const NOW3 = Date.parse('2026-11-26T15:18:00.000Z');
const tripState = ({ evalAt = '2026-11-26T03:00:00.000Z', evalState = 'trial', reverts = [] } = {}) => {
  const m = machine({ repos: [{ slug: DS, gh: 'bigbenjoman/desk-skills', levers: '`auto`' }, { slug: 'acme__ai-agents', gh: 'acme/ai-agents', levers: null }], now: NOW3 });
  const file = join(m.root, DS, 'logs', 'DS-1012.log');
  const error = 'desk-env model finder exited 3: desk-env tree-status: fatal: not a git repository (or any of the parent directories): .git';
  const at = '2026-11-26T05:30:07.208Z';
  const base = { v: 1, repo: DS, lever: 'finder-model' };
  w(join(m.root, DS, 'lever-evals.jsonl'), jsonl([{ ...ev('finder-model', { state: evalState, on: 0, off: 0, min: 40 }), at: evalAt }, { ...ev('codex', { state: 'trial', on: 2, off: 2, min: 40 }), at: evalAt }]));
  w(join(m.root, DS, 'levers.jsonl'), jsonl([
    { ...base, id: 'f1', at: '2026-11-20T08:00:00.000Z', kind: 'transition', from: 'off', to: 'trial', actor: 'controller', reason_code: 'row_change' },
    ...reverts,
    { ...base, id: 'f2', at, kind: 'trip', from: 'trial', to: reverts.length ? 'frozen' : 'reverted', actor: 'trip', reason_code: 'own_step_error', trip: 'own-step-error', ticket: 'DS-1012',
      reason: `own-step-error on DS-1012: ${error} (${file}:94)`, evidence_file: file, evidence_line: 94, error },
    { ...base, id: 'f3', at, kind: 'needs_you', actor: 'trip', reason_code: reverts.length ? 'frozen_second_revert' : 'own_step_error', ticket: 'DS-1012', evidence_file: file, evidence_line: 94,
      reason: `finder-model was reverted in desk-skills: its own step failed on DS-1012: ${error}` },
  ]));
  return V.buildView({ ...m, now: NOW3, tz: 'UTC', generatedAt: NOW3 });
};
const tripped = tripState();
const hTrip = P.renderPage(tripped);
const panelOf = (h, lever) => { const i = h.indexOf(`<div class="decide" id="decide-${lever}-`); return i < 0 ? '' : h.slice(i, h.indexOf('</td></tr>', i)); };
const rowOf = (h, lever) => section(h, 'lev-h').split(`<tr data-lever="${lever}"`)[1]?.split('</tr>')[0] ?? '';
{
  const p = panelOf(hTrip, 'finder-model');
  t('DS-1042 AC1 a decision panel under the finder-model row', section(hTrip, 'lev-h').indexOf('<tr data-lever="finder-model"') < section(hTrip, 'lev-h').indexOf('<tr class="decide-row"'), true);
  t('DS-1042 AC1 headed with the question', p.includes('<h3 class="decide-h" id="decide-finder-model-desk-skills-h">desk turned finder-model off in desk-skills. Keep it off, or test it again?</h3>'), true);
  t('DS-1042 AC1 names the ticket, the step and the exit code', p.includes('On DS-1012 a worker ran a command that included <span class="key">desk-env model finder</span>, and the command exited 3. desk counts that as the lever’s own step failing, so it turned the lever off. Nothing about review quality was measured.'), true);
  t('DS-1042 AC1 and the evidence file and line, under the repo’s state folder', p.includes('Evidence: <span class="mono">logs/DS-1012.log</span>, line 94'), true);
  const cards = [...p.matchAll(/<div class="choice" data-choice="([^"]+)"><div class="stack4"><span class="choice-h">([^<]+)<\/span>.*?<code class="mono cmd">([^<]+)<\/code><button type="button" class="copy" data-copy="([^"]+)"[^>]*>Copy<\/button>/g)].map((m) => `${m[1]}|${m[2]}|${m[3]}|${m[4]}`);
  t('DS-1042 AC2 a Keep it off and a Test it again choice, each with its command and a Copy button', j(cards), j(['off|Keep it off|levers decide desk-skills finder-model off|levers decide desk-skills finder-model off', 'trial|Test it again|levers decide desk-skills finder-model trial|levers decide desk-skills finder-model trial']));
  t('DS-1042 AC2 keeping it off, as the design words it', p.includes('Finders stay on their usual model in desk-skills. You can test it again whenever you like.'), true);
  t('DS-1042 AC5 testing again says one more revert keeps it off', p.includes('Starts a new test at 0 of 40 tickets. This is the first time desk turned it off. If desk turns it off again, it stays off until you turn it back on.'), true);
  t('DS-1042 what holds until you choose', p.includes('Until you choose, finder-model stays off. Run either command in a terminal, and this row updates on the next refresh.'), true);
  const row = rowOf(hTrip, 'finder-model');
  t('DS-1042 AC4 the repo cell says desk turned it off, with the trip’s date', row.includes('<span>desk-skills: turned off by desk, 26 Nov</span>'), true);
  t('DS-1042 AC4 not testing', row.includes('desk-skills: testing'), false);
  t('DS-1042 AC6 the progress cell waits on you since the trip', row.includes('<span class="wait tiny">Waiting on you since 26 Nov, 05:30</span>'), true);
  t('DS-1042 AC6 the summary button decides on the lever, linking its panel', hTrip.includes('<a class="cta" href="#decide-finder-model-desk-skills">Decide on finder-model</a>'), true);
  const bare = structuredClone(tripped);
  for (const i of bare.panels.waiting.items) delete i.choices;
  t('DS-1042 with no panel to link (a view saved before choices), the summary button links the levers table', P.renderPage(bare).includes('<a class="cta" href="#lev-h">Decide on finder-model</a>'), true);
  t('DS-1042 no fixed paused text', hTrip.includes('Paused until you decide'), false);
  t('DS-1042 the lever rows are still one per lever', count(section(hTrip, 'lev-h'), /<tr data-lever=/g), 12);
}
{
  const later = P.renderPage(tripState({ evalAt: '2026-11-26T06:00:00.000Z', evalState: 'reverted' }));
  t('DS-1042 AC4 an evaluation newer than the trip keeps its own state', rowOf(later, 'finder-model').includes('turned off by desk, 26 Nov'), false);
  const twice = panelOf(P.renderPage(tripState({ reverts: [{ v: 1, repo: DS, lever: 'finder-model', id: 'r0', at: '2026-11-22T08:00:00.000Z', kind: 'trip', from: 'trial', to: 'reverted', actor: 'trip', reason_code: 'own_step_error' },
    { v: 1, repo: DS, lever: 'finder-model', id: 'r1', at: '2026-11-23T08:00:00.000Z', kind: 'override', from: 'reverted', to: 'trial', actor: 'ben', reason_code: 'ben_override' }] })), 'finder-model');
  t('DS-1042 AC5 frozen after a second revert: it says so, and that one more keeps it off', twice.includes('desk has turned it off 2 times. If desk turns it off again, it stays off until you turn it back on.'), true);
  const never = panelOf(hSix, 'codex');
  t('DS-1042 an item with no revert behind it asks without saying desk turned it off', never.includes('codex in desk-skills needs your decision.') && never.includes('Codex turned off twice.'), true);
  t('DS-1042 AC5 and with no revert yet, says nothing about staying off', never.includes('If desk turns it off again'), false);
}

// DS-1042 AC3: a Copy button reads Copied once the clipboard takes its command, the other Copy again;
// where the clipboard refuses, the command is selected instead.
async function pressCopy(html, which, ok) {
  const script = html.split('<script>').pop().split('</script>')[0];
  const json = html.split('<script type="application/json" id="levers-view">')[1].split('</script>')[0];
  const el = { 'levers-view': { textContent: json }, 'age-banner': { innerHTML: '', getAttribute: () => '' }, 'age-words': { textContent: '' } };
  const button = (cmd, label) => ({ attrs: { 'data-copy': cmd, 'data-label': label, 'aria-label': label }, textContent: 'Copy', on: null,
    getAttribute(k) { return this.attrs[k]; }, setAttribute(k, val) { this.attrs[k] = val; }, addEventListener(_, f) { this.on = f; }, parentNode: { querySelector: () => ({}) } });
  const copies = [...html.matchAll(/data-copy="([^"]+)" data-label="([^"]+)"/g)].map((m) => button(m[1], m[2]));
  const wrote = [];
  let selected = 0;
  const navigator = { clipboard: { writeText: (s) => { wrote.push(s); return ok ? Promise.resolve() : Promise.reject(new Error('denied')); } } };
  const window = { getSelection: () => ({ removeAllRanges() {}, addRange() { selected += 1; } }) };
  const document = { getElementById: (id) => el[id], body: { setAttribute() {} }, querySelectorAll: (q) => (q === '[data-copy]' ? copies : []), createRange: () => ({ selectNodeContents() {} }) };
  vm.runInNewContext(script, { document, navigator, window, Date, JSON, Math, Number, Array, String, setInterval: () => 0 });
  copies[which].on();
  await new Promise((r) => setImmediate(r));
  return { labels: copies.map((b) => `${b.textContent}|${b.attrs['aria-label']}`), wrote, selected };
}
{
  const both = await pressCopy(hTrip, 1, true);
  t('DS-1042 AC3 the pressed command goes to the clipboard', j(both.wrote), j(['levers decide desk-skills finder-model trial']));
  t('DS-1042 AC3 that button reads Copied, the other Copy', j(both.labels), j(['Copy|Copy the keep-it-off command', 'Copied|Copied']));
  const refused = await pressCopy(hTrip, 0, false);
  t('DS-1042 a refused copy selects the command and leaves the button reading Copy', `${refused.selected}|${refused.labels[0]}`, '1|Copy|Copy the keep-it-off command');
}

// DS-1043: the Changes page. Six weeks in, with each repo's change log read through `changeLogs`: a
// settings change before the charts' range, a Claude version with enough tickets either side, a merged
// PR two tickets old and a settings change with few on both sides; studia-web's log can't be read.
const side = (o) => ({ accepted: 0, costed: 0, median_usd: null, audited: 0, p0: null, p1: null, p2: null, ...o });
const LOGS = {
  'desk-skills': [
    { kind: 'config', at: '2026-11-01T09:00:00.000Z', row: '§3b Phase 0 levers', from: ['none'], to: ['auto'], file: '/c/config.md', before: side({}), after: side({}) },
    { kind: 'pr', at: '2026-12-20T10:21:00.000Z', pr: 1509, ticket: 'DS-1021', title: 'A worker stops at start-up when its hooks or sign-in didn’t load', sha: 'abc1234def', paths: ['skills/x.md'],
      before: side({ accepted: 9, costed: 9, median_usd: 15.2 }), after: side({ accepted: 2, costed: 2, median_usd: 9 }) },
    { kind: 'config', at: '2026-12-22T15:20:00.000Z', row: '§3b Phase 0 levers', from: ['preflight'], to: ['auto', 'preflight'], file: '/c/config.md', before: side({ accepted: 3 }), after: side({ accepted: 1 }) },
  ],
  'ai-agents': [
    { kind: 'claude', at: '2026-12-10T21:57:00.000Z', from: '2.1.330', to: '2.1.331', ticket: 'AA-1', session: 's',
      before: side({ accepted: 14, costed: 14, median_usd: 15.2, audited: 9, p0: 0, p1: 0.5, p2: 1.25 }), after: side({ accepted: 11, costed: 11, median_usd: 9.8 }) },
  ],
};
const changeLogs = (r) => (r.name === 'studia-web' ? { log: null, error: { file: '/repos/studia-web', line: null, message: 'not a git repository' } } : { log: { window_days: 7, entries: LOGS[r.name] ?? [] }, error: null });
const withLog = V.buildView({
  ...machine({ repos: autoRepos, now: NOW2, files: { [`${DS}/lever-evals.jsonl`]: jsonl(evals), [`${DS}/levers.jsonl`]: jsonl(log), [`${DS}/levers-evidence/evl_1.jsonl`]: jsonl(rows) } }),
  now: NOW2, tz: 'UTC', generatedAt: NOW2, changeLogs,
});
withLog.panels.merge_stages = { repos: [
  { name: 'desk-skills', prs: 4, stages: { desk: { n: 4, median: 96, p75: 108 }, merge: { n: 3, median: 5, p75: 9 } } },
  { name: 'ai-agents', prs: 1, stages: { merge: { n: 1, median: 30, p75: 30 } } }] };
withLog.panels.stuck_time = { repos: [{ name: 'desk-skills', weeks: [{ week: '2026-W52', hours: 20, tickets: 5, causes: [{ cause: 'usage', hours: 15, tickets: 2, link: null }, { cause: 'lock', hours: 5, tickets: 3, link: null }] },
  { week: '2026-W51', hours: 0, tickets: 0, causes: [] }] }] };
const hLog = P.renderPage(withLog);

// The page's script against a stand-in DOM holding every element that carries a repo or a kind, the
// filter buttons and the change list's empty line.
function filterPage(html) {
  const attrsOf = (s) => Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const node = (tag, attrs) => ({ tag, attrs, hidden: false, on: null, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(_, f) { this.on = f; } });
  const els = [...html.matchAll(/<(\w+)\b([^>]*\bdata-(?:repos?|kind)="[^"]*"[^>]*|[^>]*\bdata-all\b[^>]*)>/g)]
    .map((m) => node(m[1], { ...attrsOf(m[2]), ...(/\bdata-all\b/.test(m[2]) ? { 'data-all': '' } : {}) }));
  const buttons = (k) => [...html.matchAll(new RegExp(`<button type="button" ${k}="([^"]*)" aria-pressed="[^"]*">`, 'g'))].map((m) => node('button', { [k]: m[1] }));
  const repo = buttons('data-pick-repo');
  const kind = buttons('data-pick-kind');
  // Hidden until the filter leaves nothing, as the page renders it.
  const none = { ...node('p', {}), hidden: /<p class="empty ch-none" hidden>/.test(html) };
  const json = html.split('<script type="application/json" id="levers-view">')[1].split('</script>')[0];
  const el = { 'levers-view': { textContent: json }, 'age-banner': { innerHTML: '', getAttribute: () => '' }, 'age-words': { textContent: '' } };
  const q = { '[data-pick-repo]': repo, '[data-pick-kind]': kind, '[data-repo],[data-kind],[data-all],[data-repos]': els, '.change,.change-log': els.filter((e) => /^change(-log)?$/.test(e.attrs.class)) };
  const document = { getElementById: (id) => el[id], body: { setAttribute() {} }, querySelectorAll: (s) => q[s] ?? [], querySelector: (s) => (s === '.ch-none' ? none : null) };
  vm.runInNewContext(html.split('<script>').pop().split('</script>')[0], { document, Date, JSON, Math, Number, Array, String, setInterval: () => 0 });
  const press = (group, v) => group.find((b) => Object.values(b.attrs)[0] === v).on();
  const shown = (pred) => els.filter(pred).map((e) => !e.hidden);
  return { els, repo, kind, none, press, shown };
}

{
  // AC8: titled Changes, and the old anchors still land.
  t('DS-1043 AC8 the title and heading read Changes', hLog.includes('<title>Changes</title>') && hLog.includes('<h1>Changes</h1>'), true);
  t('DS-1043 AC8 every old section id is still there', ['lev-h', 'tr-h', 'ch-h', 'ms-h', 'st-h', 'how-h'].every((id) => hLog.includes(`id="${id}"`)), true);
  // AC1: the side menu.
  const nav = hLog.split('<nav class="side" aria-label="On this page">')[1].split('</nav>')[0];
  const items = [...nav.matchAll(/<a href="#([^"]+)">([^<]+?)(?: <span class="nav-n[^"]*">(\d+)<\/span>)?<\/a>/g)].map((m) => `${m[2]}|${m[1]}|${m[3] ?? ''}`);
  t('DS-1043 AC1 the side menu lists each section, counts on Needs you and Levers', j(items), j(['Needs you|ny-h|1', 'Overview|ov-h|', 'Trends|tr-h|', 'Levers|lev-h|6', 'Changes|ch-h|', 'Merge time and parking|mp-h|', 'How desk decides|how-h|']));
  t('DS-1043 AC1 each item lands on its section', items.every((x) => hLog.includes(`id="${x.split('|')[1]}"`)), true);
  t('DS-1043 AC1 the sections in the menu’s order', ['ny-h', 'ov-h', 'tr-h', 'lev-h', 'ch-h', 'mp-h', 'how-h'].map((id) => hLog.indexOf(`id="${id}"`)).every((x, i, a) => !i || x > a[i - 1]), true);
  // AC2 (the phone-width row of buttons) is layout, checked in the screenshots, not here.
  // AC3: the repo filter.
  // In the configured order, the lever table's column order.
  t('DS-1043 AC3 a chip per repo', [...hLog.matchAll(/data-pick-repo="([^"]*)"/g)].map((m) => m[1]).join(','), ',ai-agents,studia-web,desk-skills');
  t('DS-1043 AC3 the lever cells carry their repo', section(hLog, 'lev-h').includes('<span class="repo" data-repo="desk-skills">'), true);
  t('DS-1043 AC3 so do the changes', /<div class="change-log" data-kind="other" data-repo="ai-agents"/.test(hLog) && /<details class="change" data-kind="lever" data-repo="desk-skills">/.test(hLog), true);
  t('DS-1043 AC3 and the merge-time and parking groups', ['<tbody data-repo="ai-agents"><tr class="grp">', '<span class="fold-line" data-repo="desk-skills">'].every((s) => section(hLog, 'ms-h').includes(s)) && section(hLog, 'st-h').includes('<tbody data-repo="desk-skills">'), true);
  const f = filterPage(hLog);
  f.press(f.repo, 'ai-agents');
  t('DS-1043 AC3 picking a repo shows only its parts', j([...new Set(f.els.filter((e) => e.attrs['data-repo'] && !e.hidden).map((e) => e.attrs['data-repo']))]), j(['ai-agents']));
  t('DS-1043 AC3 and hides every other repo’s', f.els.filter((e) => e.attrs['data-repo'] && e.attrs['data-repo'] !== 'ai-agents').every((e) => e.hidden), true);
  t('DS-1043 AC3 its button reads pressed', f.repo.map((b) => b.attrs['aria-pressed']).join(), 'false,true,false,false');
  const rowsIn = f.els.filter((e) => 'data-repos' in e.attrs);
  t('DS-1043 AC3 a lever row shows only where the repo has a cell', rowsIn.length > 0 && rowsIn.every((e) => e.hidden === !e.attrs['data-repos'].split(' ').includes('ai-agents')), true);
  t('DS-1043 AC3 and the reading across repos gives way to the repo’s own', f.els.filter((e) => 'data-all' in e.attrs).every((e) => e.hidden), true);
  f.press(f.repo, '');
  t('DS-1043 AC3 All repos shows them all again', f.els.every((e) => !e.hidden), true);
  {
    // preflight is kept in desk-skills alone: across repos and in desk-skills it reads Kept, in ai-agents not.
    const pre = section(hLog, 'lev-h').split('<tr data-lever="preflight"')[1].split('</tr>')[0];
    const label = (attr) => new RegExp(`<div ${attr}><span class="badge"[^>]*><span class="dot"[^>]*></span>([^<]+)</span>`).exec(pre)?.[1];
    const ai = label('data-repo="ai-agents"');
    t('DS-1043 AC3 a lever’s status, result and progress follow the picked repo', j([label('data-all'), label('data-repo="desk-skills"'), ai === undefined ? !/data-repos="[^"]*ai-agents/.test(pre) : ai !== 'Kept']), j(['Kept', 'Kept', true]));
  }
  // AC6: the kind filter.
  f.press(f.kind, 'lever');
  t('DS-1043 AC6 Lever changes shows only lever changes', j([f.shown((e) => e.attrs['data-kind'] === 'lever').every(Boolean), f.shown((e) => e.attrs['data-kind'] === 'other').some(Boolean)]), '[true,false]');
  t('DS-1043 AC6 with some left to show, the list says nothing', f.none.hidden, true);
  f.press(f.kind, 'other');
  t('DS-1043 AC6 Other changes only the others', j([f.shown((e) => e.attrs['data-kind'] === 'lever').some(Boolean), f.shown((e) => e.attrs['data-kind'] === 'other').every(Boolean)]), '[false,true]');
  f.press(f.repo, 'studia-web');
  t('DS-1043 AC6 with nothing left to show, the list says so', f.none.hidden, false);
  // AC4: merge time and parking start closed, each showing its headline line.
  for (const [id, line] of [['ms-h', 'desk-skills: desk review takes 1.6h at the median, over 4 merged PRs'], ['st-h', 'desk-skills this week: 20h parked over 5 tickets, the most hours on usage (15h)']]) {
    const sec = section(hLog, id);
    t(`DS-1043 AC4 ${id} is closed`, sec.includes('<details class="fold">') && !/<details class="fold" open/.test(sec), true);
    t(`DS-1043 AC4 ${id} shows its headline line`, sec.split('</summary>')[0].includes(`>${line}</span>`), true);
  }
  // AC5: a numbered dashed line per change in range, the same number on its list entry, and a tooltip.
  const cost = hLog.split('<article class="card wbr"')[1].split('</article>')[0];
  const dayChart = cost.split('<div class="chart" data-view="days"')[1];
  const marks = [...dayChart.matchAll(/<span class="mark(?: mark-r)?"[^>]*style="left:([\d.]+)%"[^>]*><span class="mark-n num"[^>]*>(\d+)<\/span>/g)].map((m) => [Number(m[2]), Number(m[1])]);
  t('DS-1043 AC5 the changes in range are numbered lines on the 30 days, the earlier one left off', j(marks.map((m) => m[0])), j([2, 3, 4]));
  t('DS-1043 AC5 each inside the plot, in order of when it landed', marks.every((m, i) => m[1] > 8 && m[1] < 95 && (!i || m[1] > marks[i - 1][1])), true);
  t('DS-1043 AC5 and on the 6 weeks', count(cost.split('<div class="chart" data-view="wbr"')[1].split('<div class="chart" data-view="days"')[0], /<span class="mark-n num"/g), 3);
  t('DS-1043 AC5 on every chart', count(hLog, /<div class="marks">/g), 8);
  t('DS-1043 AC5 with a legend', dayChart.includes('A change, numbered as in the list'), true);
  const ch = section(hLog, 'ch-h');
  t('DS-1043 AC5 the same numbers on the list, newest first', [...ch.matchAll(/<span class="n-badge num" aria-label="Change (\d+)">\d+<\/span>/g)].map((m) => m[1]).join(), '4,3,2,1');
  const tip = /<span class="mark-tip" role="tooltip">(.*?)<\/span><\/span>/.exec(dayChart.split('>2</span>')[1])?.[1].replace(/<[^>]+>/g, '|') ?? '';
  t('DS-1043 AC5 hovering a line shows its date, title and cost before and after', tip, '|2 · 10 Dec, 21:57 · Claude version||Claude Code 2.1.330 to 2.1.331||$15.20 before · $9.80 after||Before and after, not a test');
  t('DS-1043 AC5 the trends say what the lines are', section(hLog, 'tr-h').includes('Numbered lines are changes from the list below.'), true);
  t('DS-1043 AC5 with no change log, no lines and no such line', [hSix.includes('class="marks"'), hSix.includes('Numbered lines')].join(), 'false,false');
  // AC7: too early, with the count.
  t('DS-1043 AC7 a PR with 2 tickets since', ch.includes('<p class="small too-early">Too early: 2 tickets since. Figures show once there are 5 on each side.</p>'), true);
  t('DS-1043 AC7 a change short on both sides', ch.includes('Too early: 3 before and 1 since. Figures show once there are 5 on each side.'), true);
  const ba = ch.split('Claude Code 2.1.330 to 2.1.331')[1].split('</table>')[0].replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  t('DS-1043 AC7 one with 5 a side shows its figures', ba, '|First worker start on the new version · ai-agents|7 days before|7 days after|Cost per ticket|$15.20 · 14 tickets|$9.80 · 11 tickets|Blind review findings per PR|P0 0 · P1 0.5 · P2 1.25 · 9 reviews|not recorded|');
  t('DS-1043 a PR is named, never linked', ch.includes('PR #1509 · DS-1021 · desk-skills') && !ch.includes('href='), true);
  t('DS-1043 a settings change names its row', ch.includes('Phase 0 levers row in desk-skills: preflight to auto preflight'), true);
  t('DS-1043 a change log that can’t be read is noted', ch.includes('Couldn’t read <span class="mono">studia-web</span>'), true);
  t('DS-1043 still nothing reaches the network', /\b(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(hLog), false);
}
// AC8: a link into a closed section opens it.
{
  const html = hLog;
  const details = { tagName: 'DETAILS', open: false, parentElement: null };
  const h2 = { tagName: 'H2', parentElement: { tagName: 'SUMMARY', parentElement: details } };
  const json = html.split('<script type="application/json" id="levers-view">')[1].split('</script>')[0];
  const el = { 'levers-view': { textContent: json }, 'age-banner': { innerHTML: '', getAttribute: () => '' }, 'age-words': { textContent: '' }, 'ms-h': h2 };
  const handlers = {};
  const window = { location: { hash: '#ms-h' }, addEventListener: (k, fn) => { handlers[k] = fn; } };
  const document = { getElementById: (id) => el[id], body: { setAttribute() {} }, querySelectorAll: () => [] };
  vm.runInNewContext(html.split('<script>').pop().split('</script>')[0], { document, window, Date, JSON, Math, Number, Array, String, setInterval: () => 0 });
  t('DS-1043 AC8 opening the page at #ms-h opens Merge time by stage', details.open, true);
  details.open = false;
  window.location.hash = '#lev-h';
  handlers.hashchange();
  t('DS-1043 AC8 a link elsewhere leaves it closed', details.open, false);
}

// Every lever has its one-line description, question handling's too.
t('WHAT: question handling says what it does', /<tr data-lever="question-handling"[^>]*>.*?Decides whether a parked ticket’s question is pushed to you at once or waits for the digest/.test(section(hSix, 'lev-h')), true);

console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
