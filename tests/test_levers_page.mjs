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
  t('AC4 one row per lever', count(lev, /<tr data-lever=/g), 10);
  t('AC4 the ledger, never trialled, says it is on only where named (DS-893)', /<tr data-lever="ledger">.*?Not trialled: on only where a repo’s levers row names it\./.test(lev), true);
  t('question handling is on trial: it waits for a repo set to auto, like the others', /<tr data-lever="question-handling">.*?Testing starts (once|when) a repo is set to auto\./.test(lev), true);
  t('AC4 preflight is on by hand, first', /<tr data-lever="preflight">.*?On by hand/.test(lev) && lev.indexOf('data-lever="preflight"') < lev.indexOf('data-lever="wrappers"'), true);
  t('AC4 its next step', lev.includes('Pinned by hand in desk-skills, so this is a before-and-after, not a test.'), true);
  t('AC4 the others, quality-risk ones included, are off until a repo is on auto', count(lev, /Testing starts once a repo is set to auto\.|Testing starts when a repo is set to auto\./g), 8);
  t('AC4 this week\'s changes', section(hToday, 'ch-h').includes('>What changed this week</h2>'), true);
  t('AC4 with nothing changed', section(hToday, 'ch-h').includes('No lever changed this week.'), true);
  t('AC4 no How desk decides', hToday.includes('How desk decides'), false);
}

// AC5: the Main board.
{
  t('AC5 the status sentence', /<b>Needs you\.<\/b> Last week a ticket cost <b>[\d.]+% less<\/b> than before levers, and nothing has got worse\. 3 kept, 2 still being tested, and <b class="amber">1 needs your decision<\/b>\./.test(hSix), true);
  t('AC5 four tiles', j(tilesOf(hSix).map((x) => x.split('=')[0])), j(['Cost per ticket', 'Tokens per ticket', 'Fix tries per ticket', 'Needs you']));
  t('AC5 the needs-you tile', tilesOf(hSix)[3], 'Needs you=1');
  t('AC5 four WBR cards', count(hSix, /<article class="card wbr"/g), 4);
  const lev = section(hSix, 'lev-h');
  t('AC5 Is each lever working?, one row per lever', count(lev, /<tr data-lever=/g), 10);
  t('AC5 with results and progress', lev.includes('>Result so far</th>') && lev.includes('>Progress to a decision</th>'), true);
  t('AC5 kept first, codex needing you after the tests', [...lev.matchAll(/<tr data-lever="([^"]+)"/g)].map((m) => m[1]).join(), 'preflight,wrappers,memory,failure-class,review-reuse,codex,effort,finder-model,question-handling,ledger');
  const ch = section(hSix, 'ch-h');
  t('AC5 Every change desk made', ch.includes('>Every change desk made</h2>'), true);
  t('AC5 since testing started', ch.includes('Newest first, since testing started on 17 Nov.'), true);
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
  const kept = section(hSix, 'ch-h').split('<details class="change">')[1].split('</details>')[0];
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
  t('AC11 a change citing no evaluation says so', section(hSix, 'ch-h').split('<details class="change">')[3].includes('<dt>Tickets per arm</dt><dd><span class="muted">not recorded</span>'), true);
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

// The merge-time, learned-bar, time-parked and asks sections, in the house style of the lever table:
// one card table per section, each repo a group header row, numbers right-aligned, and every class the
// page puts on a section or table part has a CSS rule.
{
  const arm = { tickets: 30, steps: { raise: { tokens_per_ticket: 410, usd_per_ticket: 0.41 } }, pushes_per_ticket: 0, digests_per_ticket: 1, defaulted_share: 0.25, median_latency_s: 5400 };
  const full = structuredClone(six);
  full.panels.merge_stages = { repos: [{ name: 'desk-skills', prs: 4, stages: { desk: { n: 4, median: 96, p75: 108 }, merge: { n: 3, median: 5, p75: 9 } }, outage: 1,
    learned: { since: '2026-11-24T00:00:00.000Z', before: { prs: 2, rereviews: 1.5, approval: 120 }, after: { prs: 2, rereviews: 0.5, approval: 40 } } }] };
  full.panels.stuck_time = { repos: [{ name: 'desk-skills', weeks: [{ week: '2026-W52', hours: 20, tickets: 5, causes: [{ cause: 'usage', hours: 15, tickets: 2, link: null }, { cause: 'lock', hours: 0.5, tickets: 1, link: null }] }, { week: '2026-W51', hours: 0, tickets: 0, causes: [] }] }] };
  full.panels.asks = { repos: [{ name: 'desk-skills', lever: 'question-handling', at: '2026-12-28T06:00:00.000Z', state: 'trial', arms: { batched: arm, 'one-at-a-time': arm } }] };
  const h = P.renderPage(full);
  const css = h.split('<style>')[1].split('</style>')[0];
  const ruled = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  const used = new Set([...h.matchAll(/<(?:section|table|thead|tbody|tr|th|td)\b[^>]*\bclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
  t('styles: every class on a section or table part has a CSS rule', j([...used].filter((c) => !ruled.has(c))), '[]');
  for (const id of ['ms-h', 'lr-h', 'st-h', 'asks-h']) {
    const sec = h.slice(h.lastIndexOf('<section', h.indexOf(`aria-labelledby="${id}"`)), h.indexOf('</section>', h.indexOf(`aria-labelledby="${id}"`)));
    t(`styles ${id}: a card like the lever table`, /^<section aria-labelledby="[^"]+" class="card levers/.test(sec) && sec.includes('<div class="levers-head">'), true);
    t(`styles ${id}: one table`, count(sec, /<table /g), 1);
    t(`styles ${id}: a muted intro line`, /<h2 id="[^"]+">[^<]+<\/h2><p class="muted small">[^<]+<\/p>/.test(sec), true);
    t(`styles ${id}: the repo as a group header row`, /<tr class="grp"[^>]*><th scope="colgroup" colspan="\d+" class="td grp">desk-skills/.test(sec), true);
  }
  const ms = section(h, 'ms-h');
  t('styles: numbers right-aligned', ms.includes('<tr><th scope="row" class="td">desk review</th><td class="td n">1.6h</td><td class="td n">1.8h</td><td class="td n">4</td></tr>'), true);
  t('styles: their headers too', ms.includes('<th scope="col" class="th n">Median</th>'), true);
  t('styles: the outage note sits under its repo', ms.includes('1 external review wait inside a gate reviewer outage left out of the medians.'), true);
  t('styles: the right-aligned cells have tabular figures', /\.levtable \.n\{[^}]*text-align:right[^}]*font-variant-numeric:tabular-nums/.test(css), true);
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
  const incs = ch.split('<details class="change">').slice(1).filter((d) => d.includes('was incomplete'));
  t('change log: one event for the three levers', incs.length, 1);
  t('change log: naming them', incs[0]?.includes('Evidence for codex, memory and wrappers in desk-skills was incomplete'), true);
  t('change log: worded from its reason code', incs[0]?.includes('<span class="muted small">Some outcomes the evaluation reads weren’t recorded</span>'), true);
  t('change log: no absolute path anywhere in it', ch.includes('/home/x'), false);
  t('change log: the details name the tickets and files', incs[0]?.includes('<dt>Not recorded</dt><dd><ul class="guards"><li>A review round’s findings weren’t recorded: DS-261</li><li>The post-merge watch’s latest scan didn’t finish: post-merge.jsonl</li></ul></dd>'), true);
}

// Text from the view is escaped, and view.json cannot close its script element.
{
  const evil = structuredClone(six);
  evil.panels.changes.all[0].wording = '</script><img onerror=x>';
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
  t('DS-1000 AC4 the results layout names the reason as a short status, its rationale on hover', h.includes('<span class="repo" title="both arms would be the same"><span class="dot dot-sm" style="background:#9CA3AF"></span><span>desk-skills: not tested, finders already on sonnet</span>'), true);
  t('DS-1000 AC4 not the rationale as the reason', h.includes('not tested here, as'), false);
}

// Every lever has its one-line description, question handling's too.
t('WHAT: question handling says what it does', /<tr data-lever="question-handling">.*?Handles worker questions without parking the ticket/.test(section(hSix, 'lev-h')), true);

console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
