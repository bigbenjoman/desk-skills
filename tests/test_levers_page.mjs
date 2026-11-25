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

const cards = hSix.split('<article class="card wbr"').slice(1).map((c) => c.split('</article>')[0]);
const chartOf = (c, view) => c.split(`<div class="chart" data-view="${view}"`)[1].split('<div class="legend">')[0];

// AC6: each metric is a WBR card.
{
  const want = { cost: ['Cost per Ticket', 'API-equivalent spend per accepted ticket, all repos'], tokens: ['Tokens per Ticket', 'Input tokens per accepted ticket'], prompts: ['Permission Prompts per Start', 'Times a worker was blocked asking to run a command'], fixes: ['Fix Tries per Ticket', 'Must stay under 0.16 for a lever to be kept'] };
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
  v.panels.board.levers.find((l) => l.lever === 'finder-model').cells = [{ repo: 'desk-skills', state: 'ineligible', why: 'both arms would be the same', note: 'not tested in desk-skills: both arms would be the same' }];
  const h = P.renderPage(v);
  t('DS-1000 AC4 the results layout names the reason', h.includes('desk-skills: not tested here, as both arms would be the same'), true);
}

console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
