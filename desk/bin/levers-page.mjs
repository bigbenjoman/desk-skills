// The Levers page: one self-contained HTML file rendered from the Levers view model (view.json), that
// opens from file:// with the network off. It words nothing on its own: every figure, label and verdict
// is the view's, and the page only lays them out. view.json is inlined as JSON, since browsers block
// file:// fetches, and a small inline script ages the page at the moment it is opened.
//
//   import { renderPage, pageAge } from './levers-page.mjs'
import * as MS from './merge-stages.mjs';
import { fmtHours } from './stuck-time.mjs';
import { andList } from './desk-q.mjs';
import { DECISION_RULE, GUARDRAILS, KEPT_STATES as KEPT, REGISTRY, isValued } from './lever-registry.mjs';

// An age in seconds as words, for the view model and the page alike: "3 hours ago". `short` gives
// minutes as "min", as the page's header does. Runs in the browser too, so it uses nothing from outside
// its own body.
export function ageWords(s, short) {
  if (s == null) return 'never recorded';
  const m = Math.round(s / 60);
  if (m < 1) return 'under a minute ago';
  if (m < 60) return short ? `${m} min ago` : `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(s / 3600);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// The page's age when opened: stale after an hour, out of date after 26. Runs in the browser too, so it
// uses nothing from outside its own body but ageWords, which the page script also carries.
export function pageAge(generatedAt, now) {
  const at = Date.parse(generatedAt);
  if (Number.isNaN(at)) return { state: 'old', s: null, words: 'at an unknown time' };
  const s = Math.max(0, Math.round((now - at) / 1000));
  return { state: s > 26 * 3600 ? 'old' : s > 3600 ? 'stale' : 'fresh', s, words: ageWords(s, true) };
}

// The banner for an age, empty while the page is fresh. Runs in the browser too.
export function bannerHtml(age, since) {
  if (age.state === 'stale') {
    return `<div role="status" class="banner banner-stale"><span class="banner-title"><span class="dot" style="background:#D97706"></span>Updated ${age.words}</span><span class="banner-body">The supervisor may have stopped, so these numbers may be behind. Press <span class="key">v</span> in desk-q to rebuild the page.</span></div>`;
  }
  if (age.state === 'old') {
    return `<div role="alert" class="banner banner-old"><span class="banner-title">Updated ${age.words}: these numbers are out of date</span><span class="banner-body">Nothing has rebuilt this page since ${since}. Press <span class="key key-dark">v</span> in desk-q to rebuild it.</span></div>`;
  }
  return '';
}

// ---- colours and small formatters ----------------------------------------------------------------------
const C = Object.freeze({
  ink: '#111827', muted: '#6B7280', grey: '#9CA3AF', green: '#16A34A', amber: '#D97706', blue: '#3B82F6',
  greenInk: '#15803D', amberInk: '#B45309', greyInk: '#4B5563',
});
const STYLE = Object.freeze({
  kept: { dot: C.green, badge: 'background:#DCFCE7;color:#166534', label: 'Kept' },
  pinned: { dot: C.green, badge: 'background:#DCFCE7;color:#166534', label: 'On by hand' },
  testing: { dot: C.blue, badge: 'background:#DBEAFE;color:#1E40AF', label: 'Testing' },
  needs: { dot: C.amber, badge: 'background:#FEF3C7;color:#92400E', label: 'Needs you' },
  off: { dot: C.grey, badge: 'background:#F3F4F6;color:#374151', label: 'Off' },
  error: { dot: C.grey, badge: 'background:#F3F4F6;color:#374151', label: 'Couldn’t read' },
});
const WHAT = Object.freeze({
  preflight: 'Skips the start-up check when nothing has changed',
  wrappers: 'Runs often-blocked commands through approved scripts',
  memory: 'Starts workers with a short summary instead of full memory',
  'failure-class': 'Reruns a ticket once when CI failed for a machine reason',
  'review-reuse': 'Keeps review notes after a rebase instead of reviewing it all again',
  codex: 'Has Codex review pull requests instead of Claude',
  effort: 'Uses less thinking on simple steps',
  'finder-model': 'Runs the review’s Claude finders on a cheaper model',
  'question-handling': 'Decides whether a parked ticket’s question is pushed to you at once or waits for the digest',
  'handoff-threshold': 'Sets how full a worker’s context gets before it hands off to a fresh session',
  ledger: 'Records every queue change in a ticket log beside queue.json',
});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const DASH = '—';
const MINUS = '−';
const trim = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
const signed = (v, dp = 2) => (v == null ? DASH : `${v < 0 ? MINUS : ''}${trim(Math.abs(v).toFixed(dp))}`);
const pctCell = (v) => (v == null ? DASH : `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(1)}%`);
const basename = (p) => String(p ?? '').split('/').pop();
const count = (n) => Number(n).toLocaleString('en-GB');

const fmt = (tz, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts });
const clock = (iso, tz) => fmt(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const dayMonth = (iso, tz) => fmt(tz, { day: 'numeric', month: 'short' }).format(new Date(iso));
const when = (iso, tz) => `${dayMonth(iso, tz)}, ${clock(iso, tz)}`;
const since = (iso, tz) => `${fmt(tz, { weekday: 'short' }).format(new Date(iso))} ${when(iso, tz)}`;
// A calendar day key (YYYY-MM-DD) as "6 Nov".
const dayLabel = (k) => dayMonth(`${k}T12:00:00Z`, 'UTC');
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const isoWeek = (k) => {
  const d = new Date(`${k}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - jan4) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
};

// ---- the four trend metrics, as the page titles and formats them ------------------------------------------
const fixLimit = (base) => (base == null ? null : Math.round(base * GUARDRAILS['fix-tries-parks'].margin.max_rate_ratio * 100) / 100);
// `sub` words a card's one-line description from its baseline and whether the view keyed its days by
// the day each ticket merged.
const perTicket = (merged) => (merged ? 'per merged ticket, by the day it merged' : 'per accepted ticket');
const METRICS = Object.freeze({
  cost: { title: 'Cost per Ticket', tile: 'Cost per ticket', sub: (_, merged) => `API-equivalent spend ${perTicket(merged)}, all repos`, scale: 1, v: (x) => `$${x.toFixed(2)}`, pre: '$', post: '' },
  tokens: { title: 'Tokens per Ticket', tile: 'Tokens per ticket', sub: (_, merged) => `Input tokens ${perTicket(merged)}`, scale: 1e-6, v: (x) => `${x.toFixed(1)}M`, pre: '', post: 'M' },
  prompts: { title: 'Permission Prompts per Start', tile: 'Prompts per start', sub: (_, merged) => `Times a worker was blocked asking to run a command${merged ? ', per start, by the day its ticket merged' : ''}`, scale: 1, v: (x) => x.toFixed(1), pre: '', post: '' },
  fixes: {
    title: 'Fix Tries per Ticket', tile: 'Fix tries per ticket', scale: 1, v: (x) => x.toFixed(2), pre: '', post: '', minStep: 0.01,
    sub: (base, merged) => {
      const limit = fixLimit(base) == null ? null : `Must stay under ${fixLimit(base).toFixed(2)} for a lever to be kept`;
      if (!merged) return limit ?? 'Fix tries per accepted ticket';
      return limit ? `${cap(perTicket(true))}. ${limit}` : `Fix tries ${perTicket(true)}`;
    },
  },
});
const scaled = (m, v) => (v == null ? null : v * m.scale);

// Lower is better for every metric: green under the baseline, amber over it, grey with nothing to compare.
// Fix tries are judged against their guardrail limit instead.
// `over` is the figure judged: last week's (the cards) or the one since desk started recording (the tiles).
function rag(key, metric, over = 'last_week') {
  const vs = metric.callouts[`${over}_vs_before_pct`];
  const better = vs != null && vs <= -1;
  if (key === 'fixes') {
    const limit = fixLimit(metric.baseline.value);
    const last = metric.callouts[over];
    if (limit == null || last == null) return { c: C.grey, label: 'Grey: no comparison yet', words: 'No comparison yet' };
    if (last > limit) return { c: C.amber, label: `Amber: over the ${limit.toFixed(2)} limit`, words: `Over the ${limit.toFixed(2)} limit`, ink: C.amberInk };
    return { c: C.green, label: `Green: under the ${limit.toFixed(2)} limit`, words: better ? 'Better than before levers' : 'Holding steady', ink: better ? C.greenInk : '#374151', dot: better ? C.green : C.grey };
  }
  if (vs == null) return { c: C.grey, label: 'Grey: no comparison yet', words: 'No comparison yet' };
  if (better) return { c: C.green, label: 'Green: better than before levers', words: 'Better than before levers', ink: C.greenInk };
  if (vs >= 1) return { c: C.amber, label: 'Amber: higher than before levers', words: 'Higher than before levers', ink: C.amberInk };
  return { c: C.grey, label: 'Grey: about the same as before levers', words: 'Holding steady' };
}

// ---- the WBR chart, as inline SVG with an HTML label layer ------------------------------------------------
// Geometry from studia-web's wbr-chart.tsx buildFullOptions: 700 by 340, plot from 12% to 84% down.
const W = 700;
const H = 340;
const TOP = H * 0.12;
const BOT = H * 0.84;
// About how wide one character of a 10px label is, in chart units, with the chart drawn about 560px wide.
const LABEL_W = 7;
// Below this many weekly points the trends open on the last 30 days, where a new lever shows sooner.
const WEEKS_FOR_WBR = 3;
// The view the trends open on, which the tiles' sparklines follow: 'wbr' once a metric has WEEKS_FOR_WBR
// weekly points, 'days' before.
const openOn = (metrics) => (Math.max(0, ...Object.values(metrics ?? {}).map((x) => (x.weekly ?? []).filter((p) => p.value != null).length)) >= WEEKS_FOR_WBR ? 'wbr' : 'days');
function nice(lo, hi, minStep) {
  const span = hi - lo;
  const raw = Math.max(span / 4, minStep || 0) || Math.max(Math.abs(hi) / 4, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const st = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { lo: Math.floor(lo / st) * st, hi: Math.ceil(hi / st) * st, st };
}
const decimals = (st) => (String(Number(st.toFixed(6))).split('.')[1] ?? '').length;

// One panel of a chart into `o`: its gridlines, axis, ticks, the baseline in grey, the series in black
// with a gap wherever a point is null, and a note over the points that end before desk's first recorded
// day (`ends` holds each point's last day). A gap after that day is a period with no tickets, so no note.
function panel(o, { labels, vals, ends, base, m, x0, x1, side, every, first }) {
  const n = labels.length;
  const dx = (x1 - x0) / n;
  const xAt = (i) => x0 + dx * (i + 0.5);
  const got = vals.filter((v) => v != null);
  o.axes.push({ x0, x1 });
  labels.forEach((l, i) => { o.ticks.push(xAt(i)); if ((n - 1 - i) % every === 0) o.labels.push({ x: xAt(i), y: BOT + 8, tf: 'translate(-50%,0)', s: l, c: '#6E7079' }); });
  if (!got.length && base == null) { o.labels.push({ x: (x0 + x1) / 2, y: (TOP + BOT) / 2, tf: 'translate(-50%,-50%)', s: 'No tickets yet', c: C.grey }); return; }
  const span = [...got, ...(base == null ? [] : [base])];
  const r = nice(Math.min(...span) * 0.97, Math.max(...span) * 1.03, m.minStep);
  const y = (v) => BOT - ((v - r.lo) / (r.hi - r.lo || 1)) * (BOT - TOP);
  const dp = decimals(r.st);
  for (let v = r.lo; v <= r.hi + 1e-9; v += r.st) {
    o.grid.push({ x0, x1, y: y(v) });
    o.labels.push({ x: side === 'left' ? x0 - 8 : x1 + 8, y: y(v), tf: side === 'left' ? 'translate(-100%,-50%)' : 'translate(0,-50%)', s: `${m.pre}${v.toFixed(dp)}${m.post}`, c: '#6E7079' });
  }
  if (base != null) {
    const by = y(base);
    o.bases.push(labels.map((_, i) => `${xAt(i).toFixed(1)},${by.toFixed(1)}`).join(' '));
    labels.forEach((_, i) => o.bdots.push({ x: xAt(i), y: by }));
  }
  let cur = [];
  vals.forEach((v, i) => {
    if (v == null) { if (cur.length) o.segs.push(cur.join(' ')); cur = []; return; }
    cur.push(`${xAt(i).toFixed(1)},${y(v).toFixed(1)}`);
    o.dots.push({ x: xAt(i), y: y(v) });
    // Centred on its point, but kept inside the panel so it never runs into the tick labels beside it;
    // above the point, or under a dip (the line into and out of it runs above), room allowing.
    if (every === 1 || (n - 1 - i) % every === 0) {
      const s = m.v(v);
      const w = s.length * LABEL_W;
      const prev = vals[i - 1];
      const next = vals[i + 1];
      const dip = prev != null && prev > v && (next == null || next > v) && y(v) + 18 <= BOT;
      o.labels.push({ x: Math.max(x0, Math.min(xAt(i) - w / 2, x1 - w)), y: dip ? y(v) + 6 : y(v) - 6, tf: dip ? 'translate(0,0)' : 'translate(0,-100%)', s, c: C.ink });
    }
  });
  if (cur.length) o.segs.push(cur.join(' '));
  const pre = first ? ends.filter((k) => k < first).length : 0;
  if (pre) {
    // Above the top of the plot, so it never strikes through the baseline. A gap too narrow to centre
    // the note in starts it at the gap's left edge instead.
    const wide = pre * dx >= 160;
    o.labels.push({ x: wide ? x0 + (pre * dx) / 2 : x0 + 4, y: TOP - 4, tf: wide ? 'translate(-50%,-100%)' : 'translate(0,-100%)', s: `desk started recording on ${dayLabel(first)}`, c: C.grey, note: true });
  }
}

// The last day of a week starting on `k`, and of the month `m` (YYYY-MM), as day keys.
const weekEnd = (k) => new Date(Date.parse(`${k}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
const monthEnd = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);

// Where each change log entry lands on a panel: `keys` are the panel's day keys (a day's, or a week's
// first day with `span` 7), x0..x1 its plot. A change before the first is left off; one after the last
// sits on the right edge. -> [{ e, x }]
const DAY_MS = 86_400_000;
function markXs(entries, keys, span, x0, x1) {
  if (!keys.length) return [];
  const dx = (x1 - x0) / keys.length;
  const start = Date.parse(`${keys[0]}T00:00:00Z`);
  return entries.flatMap((e) => {
    const at = ((Date.parse(`${e.day}T00:00:00Z`) - start) / DAY_MS + (e.day_frac ?? 0)) / span;
    if (!(at >= 0)) return [];
    return [{ e, x: Math.min(x0 + dx * at, x1 - 1) }];
  });
}

// The numbered dashed lines over a chart, each with its tooltip: the number, when and what kind, the
// title, the cost either side (or Too early) and that it is no test. Numbers within ~2.4% of the one
// before go a row lower, so they never sit on each other.
function marksHtml(placed, tz, px) {
  const rowEnd = [];
  return placed.sort((a, b) => a.x - b.x).map(({ e, x }) => {
    const pct = (x / W) * 100;
    let row = rowEnd.findIndex((end) => pct - end >= 2.4);
    if (row < 0) row = rowEnd.length;
    rowEnd[row] = pct;
    const kind = LOG_KIND[e.kind]?.label ?? 'Change';
    const cost = tooEarly(e) ?? `${sideCost(e.before) ?? 'not recorded'} before · ${sideCost(e.after) ?? 'not recorded'} after`;
    const title = logHead(e).title;
    const head = `${e.n} · ${when(e.at, tz)} · ${kind}`;
    return `<span class="mark${pct > 50 ? ' mark-r' : ''}"${repoAttr(e.repo)} tabindex="0" style="left:${px(x)}" aria-label="${esc(`Change ${head}. ${title}. ${cost}. Before and after, not a test.`)}">`
      + `<span class="mark-n num" style="top:${row * 18}px">${e.n}</span>`
      + `<span class="mark-tip" role="tooltip"><span class="tiny">${esc(head)}</span><span class="b">${esc(title)}</span><span class="small">${esc(cost)}</span><span class="tiny mark-note">Before and after, not a test</span></span></span>`;
  }).join('');
}

function chart(key, metric, view, shown, { changeLog = [], tz = 'UTC' } = {}) {
  const m = METRICS[key];
  const base = scaled(m, metric.baseline.value);
  const o = { grid: [], axes: [], ticks: [], labels: [], bases: [], bdots: [], segs: [], dots: [] };
  const first = metric.first_recorded;
  let placed;
  if (view === 'days') {
    panel(o, { labels: metric.daily.map((p) => dayLabel(p.date)), vals: metric.daily.map((p) => scaled(m, p.value)), ends: metric.daily.map((p) => p.date), base, m, x0: W * 0.08, x1: W * 0.95, side: 'left', every: 5, first });
    placed = markXs(changeLog, metric.daily.map((p) => p.date), 1, W * 0.08, W * 0.95);
  } else {
    // On the 6 weeks, by the week it fell in and how far through that week.
    placed = markXs(changeLog, metric.weekly.map((p) => p.week), 7, W * 0.08, W * 0.48);
    panel(o, { labels: metric.weekly.map((p) => `WK ${isoWeek(p.week)}`), vals: metric.weekly.map((p) => scaled(m, p.value)), ends: metric.weekly.map((p) => weekEnd(p.week)), base, m, x0: W * 0.08, x1: W * 0.48, side: 'left', every: 1, first });
    panel(o, { labels: metric.monthly.map((p) => MONTHS[Number(p.month.slice(5, 7)) - 1]), vals: metric.monthly.map((p) => scaled(m, p.value)), ends: metric.monthly.map((p) => monthEnd(p.month)), base, m, x0: W * 0.54, x1: W * 0.91, side: 'right', every: 2, first });
  }
  const f1 = (v) => v.toFixed(1);
  const aria = `${m.title}: ${view === 'days' ? 'each of the last 30 days' : 'last 6 weeks on the left, last 12 months on the right'}. Black is now${base == null ? '' : `, grey is before levers at ${m.v(base)}`}.`;
  const px = (x) => `${((x / W) * 100).toFixed(3)}%`;
  const py = (y) => `${((y / H) * 100).toFixed(3)}%`;
  return `<div class="chart" data-view="${view}"${view === shown ? '' : ' hidden'}>
<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" role="img" aria-label="${esc(aria)}">
${o.grid.map((g) => `<line x1="${f1(g.x0)}" y1="${f1(g.y)}" x2="${f1(g.x1)}" y2="${f1(g.y)}" stroke="#E0E6F1"></line>`).join('')}
${o.axes.map((a) => `<line x1="${f1(a.x0)}" y1="${f1(BOT)}" x2="${f1(a.x1)}" y2="${f1(BOT)}" stroke="#6E7079"></line>`).join('')}
${o.ticks.map((x) => `<line x1="${f1(x)}" y1="${f1(BOT)}" x2="${f1(x)}" y2="${f1(BOT + 5)}" stroke="#6E7079"></line>`).join('')}
${o.bases.map((p) => `<polyline class="base" points="${p}" fill="none" stroke="${C.grey}" stroke-width="1.5"></polyline>`).join('')}
${o.bdots.map((d) => `<circle cx="${f1(d.x)}" cy="${f1(d.y)}" r="1.5" fill="${C.grey}"></circle>`).join('')}
${o.segs.map((p) => `<polyline class="now" points="${p}" fill="none" stroke="${C.ink}" stroke-width="2.5"></polyline>`).join('')}
${o.dots.map((d) => `<circle class="pt" cx="${f1(d.x)}" cy="${f1(d.y)}" r="3" fill="${C.ink}"></circle>`).join('')}
</svg>
<div class="chart-labels" aria-hidden="true">${o.labels.map((b) => `<span${b.note ? ' class="gap-note"' : ''} style="left:${px(b.x)};top:${py(b.y)};transform:${b.tf};color:${b.c}">${esc(b.s)}</span>`).join('')}</div>
${placed.length ? `<div class="marks">${marksHtml(placed, tz, px)}</div>` : ''}
<div class="legend"><span><span class="swatch" style="background:${C.ink}"></span>${esc(m.title)}</span>${base == null ? '' : `<span><span class="swatch" style="background:${C.grey}"></span>Before levers</span>`}${placed.length ? '<span><span class="swatch swatch-dash"></span>A change, numbered as in the list</span>' : ''}</div>
</div>`;
}

const CALLOUTS = [['Yesterday', 'yesterday', false], ['DoD%', 'dod_pct', true], ['Last Wk', 'last_week', false], ['WoW%', 'wow_pct', true], ['vs before', 'last_week_vs_before_pct', true], ['MTD', 'mtd', false], ['MoM%', 'mom_pct', true], ['To date', 'to_date', false], ['vs before', 'to_date_vs_before_pct', true]];
function wbrCard(key, metric, shown, marks) {
  const m = METRICS[key];
  const r = rag(key, metric);
  const cells = CALLOUTS.map(([l, k, pct]) => {
    const v = metric.callouts[k];
    if (v == null) return { l, v: DASH, c: C.grey };
    if (!pct) return { l, v: m.v(scaled(m, v)), c: C.ink };
    return { l, v: pctCell(v), c: v < 0 ? C.green : v > 0 ? C.amber : C.ink };
  });
  return `<article class="card wbr" data-metric="${key}">
<div class="wbr-head"><div></div><h3>${esc(m.title)}</h3><div class="wbr-rag"><span class="rag" role="img" aria-label="${esc(r.label)}" title="${esc(r.label)}" style="background:${r.c}"></span></div></div>
<p class="muted wbr-sub">${esc(m.sub(metric.baseline.value, metric.keyed_by === 'merged_at'))}</p>
${chart(key, metric, 'wbr', shown, marks)}
${chart(key, metric, 'days', shown, marks)}
<div class="callouts">${cells.map((k) => `<div class="callout"><span class="callout-l">${esc(k.l)}</span><span class="callout-v mono" style="color:${k.c}">${esc(k.v)}</span></div>`).join('')}</div>
</article>`;
}

// ---- notes for a panel's errors ---------------------------------------------------------------------------
function errorNote(e) {
  const what = e.line ? `Couldn’t read line ${e.line} of <span class="mono">${esc(basename(e.file))}</span>` : `Couldn’t read <span class="mono">${esc(basename(e.file))}</span>`;
  return `<div role="status" class="note"><span class="dot" style="background:${C.amber};margin-top:6px"></span><span>${what}, so what it holds is left out here. Everything else in this section is shown.<span class="note-path mono">${esc(e.file)}${e.message ? `: ${esc(e.message)}` : ''}</span></span></div>`;
}
const notes = (p) => (p?.errors ?? []).map(errorNote).join('');

// ---- the sections ---------------------------------------------------------------------------------------------
// A view in which no lever has been evaluated is the page before any trial: the Today board.
const evaluated = (v) => (v.panels.board.levers ?? []).some((l) => l.cells.some((c) => c.sample));
const leverItems = (v) => (v.panels.waiting.items ?? []).filter((i) => i.kind === 'lever');

function summary(v) {
  const l = v.line;
  const needs = l.needs_you ?? 0;
  const needsText = needs ? `<b class="amber">${needs} need${needs === 1 ? 's' : ''} your decision</b>` : null;
  let lead;
  let body;
  if (l.state === 'broken') {
    lead = 'Some results can’t be read.';
    body = `${l.error?.line ? `Line ${esc(l.error.line)} of ` : ''}<span class="mono">${esc(basename(l.error?.file))}</span> can’t be read. The sections that read it say what they left out.`;
  } else if (l.state === 'today') {
    lead = 'Not started yet.';
    body = `${v.baseline ? 'desk has recorded what a ticket costs with no levers on. ' : 'desk has no record yet of what a ticket costs with no levers on. '}${l.on_auto ? 'Testing starts with the next tickets desk admits.' : 'Testing starts once a repo is set to auto.'} ${needsText ? `${needsText}.` : 'Nothing needs you.'}`;
  } else if (l.state === 'early') {
    lead = 'Too early to tell.';
    const arm = l.smaller_arm ? ` The smaller side has ${l.smaller_arm.n} of the ${l.smaller_arm.min} tickets desk needs to decide.` : '';
    body = `${l.testing} lever${l.testing === 1 ? ' is' : 's are'} being tested.${arm} ${needsText ? `${needsText}.` : 'Nothing needs you.'}`;
  } else {
    lead = l.state === 'needs_you' ? 'Needs you.' : 'Working.';
    const breached = (v.panels.guardrails.rows ?? []).some((g) => g.status === 'breached');
    const pct = l.cheaper_pct;
    const cost = pct == null ? '' : `Last week a ticket cost <b>${Math.abs(pct).toFixed(1)}% ${pct >= 0 ? 'less' : 'more'}</b> than before levers${breached ? ', and a guardrail has been breached' : ', and nothing has got worse'}. `;
    body = `${cost}${l.kept} kept, ${l.testing} still being tested${needsText ? `, and ${needsText}` : ''}.`;
  }
  return `<p class="lede"><b>${lead}</b> ${body}</p>`;
}

// Needs you: each lever item's question, with a button to its decision panel. leverTable draws that panel
// only for an evaluated page's lever row whose ask has choices; otherwise the button opens the table.
function needsYou(v) {
  const items = leverItems(v);
  if (!items.length) return `<section aria-labelledby="ny-h" class="stack4"><h2 id="ny-h">Needs you</h2><p class="muted small">Nothing needs you. desk asks here when a lever needs a decision.</p></section>`;
  const panelled = (a) => a.choices && evaluated(v) && (v.panels.board.levers ?? []).some((b) => b.lever === a.lever);
  const cta = (a) => (a.lever
    ? `<a class="cta" href="#${panelled(a) ? decideId(a) : 'lev-h'}">Decide on ${esc(a.lever)}</a>`
    : `<a class="cta" href="#lev-h">Review what needs you${a.repo ? ` in ${esc(a.repo)}` : ''}</a>`);
  return `<section aria-labelledby="ny-h" class="card needs-box"><h2 id="ny-h" class="needs-label">Needs you · ${items.length}</h2>`
    + `${items.map((a) => `<div class="needs-item"${repoAttr(a.repo)}><p class="needs-q">${esc(askHead(a))}</p>${cta(a)}</div>`).join('')}</section>`;
}

// Overview: where testing stands in a sentence, then the headline numbers.
const overview = (v, today) => `<section aria-labelledby="ov-h" class="stack12"><div class="stack4"><h2 id="ov-h">Overview</h2>${summary(v)}</div>${notes(v.panels.status)}${tiles(v, today)}</section>`;

function spark(metric, m, shown) {
  const vals = (shown === 'days' ? metric.daily : metric.weekly).map((p) => scaled(m, p.value));
  const base = scaled(m, metric.baseline.value);
  const all = [...vals.filter((x) => x != null), ...(base == null ? [] : [base])];
  if (!all.length) return '';
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const y = (x) => (hi === lo ? 16 : 28 - ((x - lo) / (hi - lo)) * 24).toFixed(1);
  const pts = vals.map((x, i) => (x == null ? null : `${((i / (vals.length - 1)) * 220).toFixed(0)},${y(x)}`)).filter(Boolean).join(' ');
  return `<svg viewBox="0 0 220 32" width="100%" height="32" aria-hidden="true" class="spark">${base == null ? '' : `<line x1="0" y1="${y(base)}" x2="220" y2="${y(base)}" stroke="${C.grey}" stroke-dasharray="3 3" stroke-width="1"></line>`}<polyline points="${pts}" fill="none" stroke="${C.ink}" stroke-width="2"></polyline></svg>`;
}

const tile = (t) => `<article class="card tile"${t.edge ? ' style="border-color:#FCD34D;background:#FFFBEB"' : ''}><h3 class="muted">${esc(t.label)}</h3><span class="num tile-v">${esc(t.value)}</span><span class="tile-s" style="color:${t.ink ?? '#374151'}"><span class="dot" style="background:${t.dot ?? C.grey}"></span>${esc(t.status)}</span><span class="muted num tile-sub">${esc(t.sub)}</span>${t.sub2 ? `<span class="muted num tile-sub">${esc(t.sub2)}</span>` : ''}${t.spark ?? ''}</article>`;

function tiles(v, today) {
  const b = v.baseline;
  let list;
  if (today) {
    const from = b?.window?.from;
    const to = b?.window?.to;
    const [fd, fm] = from ? dayMonth(from, v.tz).split(' ') : [];
    const range = from && to ? `, ${dayMonth(to, v.tz).endsWith(fm) ? fd : `${fd} ${fm}`}–${dayMonth(to, v.tz)}` : '';
    const status = b ? 'Starting point' : 'Not recorded';
    list = [
      { label: 'Cost per ticket', value: b?.cost == null ? DASH : `$${b.cost.toFixed(2)}`, status, sub: b ? `Before levers · ${b.accepted} tickets${range}` : 'No Phase 0 baseline yet' },
      { label: 'Tokens per ticket', value: b?.input_tokens == null ? DASH : `${(b.input_tokens / 1e6).toFixed(1)}M`, status, sub: b?.output_tokens == null ? 'Input tokens' : `Input tokens · ${Math.round(b.output_tokens / 1000)}k output` },
      { label: 'Fix tries per ticket', value: b?.fix_tries == null ? DASH : b.fix_tries.toFixed(2), status, sub: 'A lever must not raise this' },
      { label: 'Permission prompts', value: b?.denials == null ? DASH : count(b.denials), status, sub: b?.accepted ? `Across the ${b.accepted} tickets` : 'Before levers' },
    ];
  } else {
    const ms = v.panels.trends.metrics;
    const metricTile = (key) => {
      const m = METRICS[key];
      const metric = ms[key];
      // The figure since desk started recording, its window and ticket count; last week's and
      // yesterday's beneath it, each with its own count.
      const r = rag(key, metric, 'to_date');
      const c = metric.callouts;
      const n = metric.counts ?? {};
      const fig = (x) => (x == null ? DASH : m.v(scaled(m, x)));
      const tickets = (k) => (n[k] == null ? '' : `, ${plural(n[k], 'ticket')}`);
      const window = metric.first_recorded ? `Since ${dayLabel(metric.first_recorded)}${n.to_date == null ? '' : ` · ${plural(n.to_date, 'ticket')}`}` : 'Nothing recorded yet';
      const recent = `Last week ${fig(c.last_week)}${tickets('last_week')} · Yesterday ${fig(c.yesterday)}${tickets('yesterday')}`;
      return { label: m.tile, value: fig(c.to_date), status: r.words, ink: r.ink, dot: r.dot ?? r.c, sub: window, sub2: recent, spark: spark(metric, m, openOn(ms)) };
    };
    const items = leverItems(v);
    const first = items[0];
    list = [metricTile('cost'), metricTile('tokens'), metricTile('fixes'), items.length
      ? { label: 'Needs you', value: String(items.length), status: `${first.lever ?? 'A lever'}${first.repo ? ` in ${first.repo}` : ''}`, ink: C.amberInk, dot: C.amber, sub: first.command ? `Open it with ${first.command}` : (first.text ?? ''), edge: true }
      : { label: 'Needs you', value: '0', status: 'Nothing needs you', sub: 'desk will ask here when a lever needs a decision' }];
  }
  const none = !today && list.slice(0, 3).every((t) => t.value === DASH);
  return `<section aria-label="Headline numbers" class="tiles">${list.map(tile).join('')}</section>${none ? `<p class="muted small">No ticket has merged since desk started recording, so each number shows ${DASH}.</p>` : ''}`;
}

function trends(v) {
  const p = v.panels.trends;
  const ms = p.metrics ?? {};
  const has = p.state !== 'empty' && Object.values(ms).some((m) => m.first_recorded);
  // The 6-week and 12-month view once a metric has WEEKS_FOR_WBR weekly points, the last 30 days before.
  const shown = openOn(ms);
  const pressed = (k) => `aria-pressed="${k === shown}"`;
  const hide = (k) => (k === shown ? '' : ' hidden');
  const toggle = `<div role="group" aria-label="Chart view" class="toggle"><button type="button" data-show="wbr" ${pressed('wbr')}>6 weeks &amp; 12 months</button><button type="button" data-show="days" ${pressed('days')}>Last 30 days</button></div>`;
  const changeLog = v.panels.change_log?.entries ?? [];
  const lines = has && changeLog.length ? ' Numbered lines are changes from the list below.' : '';
  const head = `<div class="sec-head"><div class="stack4"><h2 id="tr-h">Trends</h2><p class="muted small" data-view="wbr"${hide('wbr')}>Black is now, grey is before levers. Left: the last 6 weeks. Right: the last 12 months.${lines}</p><p class="muted small" data-view="days"${hide('days')}>Black is now, grey is before levers. One point a day, so a lever shows within days.${lines}</p></div>${toggle}</div>`;
  const body = has
    ? `<div class="cards">${Object.keys(METRICS).filter((k) => ms[k]).map((k) => wbrCard(k, ms[k], shown, { changeLog, tz: v.tz })).join('')}</div>`
    : `<div class="cards">${Object.values(METRICS).map((m) => `<article class="card awaiting"><div class="awaiting-head"><h3>${esc(m.title)}</h3><span class="rag rag-sm" role="img" aria-label="Grey: no data yet" style="background:${C.grey}"></span></div><div class="awaiting-body"><span class="muted">Awaiting data</span><span class="muted small">This fills in once desk has evaluated its first tickets.</span></div></article>`).join('')}</div>`;
  return `<section aria-labelledby="tr-h" class="stack12">${head}${notes(p)}${body}</section>`;
}

// A data section in the house style of "Is each lever working?": a card with its heading and a muted
// intro line, then one table, each group (a repo, or a repo's week or lever) a header row over its rows.
// `cols` are { label, num }, a numeric column right-aligned with tabular figures; each row is its cells
// as HTML, the first its row header, or { sub } for a header row over the rows after it inside the group,
// or { empty } for a muted line standing in for rows; a group's `note` is a muted line under its rows.
// Each group is its own tbody, carrying its `repo` for the repo filter. With `fold` (one headline per
// repo, { repo, text }), the section starts closed, showing its title and headlines, and opens on click
// to its intro and table.
function dataSection({ id, title, intro, cols, groups, fold = null }) {
  const cls = (c, base) => `${base}${c.num ? ' n' : ''}`;
  const head = `<tr>${cols.map((c) => `<th scope="col" class="${cls(c, 'th')}">${esc(c.label)}</th>`).join('')}</tr>`;
  const row = (r) => (r.sub != null ? `<tr><th scope="colgroup" colspan="${cols.length}" class="td sgrp">${esc(r.sub)}</th></tr>`
    : r.empty != null ? `<tr><td colspan="${cols.length}" class="td muted small">${esc(r.empty)}</td></tr>`
      : `<tr>${r.map((v, i) => (i === 0 ? `<th scope="row" class="td">${v}</th>` : `<td class="${cls(cols[i], 'td')}">${v}</td>`)).join('')}</tr>`);
  const body = groups.map((g) => `<tbody${repoAttr(g.repo)}><tr class="grp"${g.attrs ?? ''}><th scope="colgroup" colspan="${cols.length}" class="td grp">${esc(g.head)}</th></tr>`
    + g.rows.map(row).join('')
    + (g.note ? `<tr><td colspan="${cols.length}" class="td muted small">${esc(g.note)}</td></tr>` : '') + '</tbody>').join('');
  const table = `<div class="scroll"><table class="levtable data"><thead>${head}</thead>${body}</table></div>`;
  if (!fold) {
    return `<section aria-labelledby="${id}" class="card levers"><div class="levers-head"><div class="stack4"><h2 id="${id}">${esc(title)}</h2><p class="muted small">${esc(intro)}</p></div></div>${table}</section>`;
  }
  const lines = fold.map((f) => `<span class="fold-line"${repoAttr(f.repo)}>${esc(f.text)}</span>`).join('');
  return `<section aria-labelledby="${id}" class="card levers"><details class="fold"><summary class="levers-head fold-sum"><h2 id="${id}">${esc(title)}</h2><span class="muted small fold-lines">${lines}</span><span class="fold-cue small"><span class="fold-show">Show table</span><span class="fold-hide">Hide table</span></span></summary>`
    + `<p class="muted small fold-intro">${esc(intro)}</p>${table}</details></section>`;
}
const repoAttr = (repo) => (repo && repo !== '*' ? ` data-repo="${esc(repo)}"` : '');
// The repos the repo filter offers, in config order: none until there are two to pick between.
const repoNames = (v) => { const n = (v.repos ?? []).map((r) => r.name).filter(Boolean); return n.length < 2 ? [] : n; };

// The outside reviewer's re-reviews per PR and undraft-to-approval time, before and after the learned
// review bar began (review-misses.mjs beforeAfter), for each repo with one. Nothing until a check has
// been learned.
function learned(v) {
  const repos = (v.panels.merge_stages?.repos ?? []).filter((r) => r.learned);
  if (!repos.length) return '';
  const row = (name, s) => [name, String(s.prs), s.rereviews == null ? DASH : esc(String(s.rereviews)), esc(MS.fmt(s.approval))];
  return dataSection({
    id: 'lr-h', title: 'Learned review bar', intro: 'The outside reviewer’s re-reviews per PR and the time from undraft to approval, before and after desk learned its review bar.',
    cols: [{ label: 'Learned bar' }, { label: 'PRs', num: true }, { label: 'External re-reviews per PR', num: true }, { label: 'Undraft to approval (median)', num: true }],
    groups: repos.map((r) => ({ repo: r.name, head: `${r.name} · learned review bar since ${String(r.learned.since).slice(0, 10)}`, rows: [row('Before', r.learned.before), row('After', r.learned.after)] })),
  });
}

// A repo's slowest stage at the median, as the closed section's headline.
function stagesHeadline(r) {
  const slow = MS.STAGES.filter((k) => r.stages?.[k]?.n && r.stages[k].median != null).sort((a, b) => r.stages[b].median - r.stages[a].median)[0];
  return { repo: r.name, text: slow ? `${r.name}: ${MS.STAGE_NAMES[slow]} takes ${MS.fmt(r.stages[slow].median)} at the median, over ${plural(r.stages[slow].n, 'merged PR')}` : `${r.name}: ${plural(r.prs, 'merged PR')}` };
}

// Each repo's merged PR time by stage (merge-stages.mjs): median and p75 per stage, and how many
// external waits inside a reviewer outage were left out. Nothing until a merged PR has its stages.
function mergeStages(v) {
  const repos = v.panels.merge_stages?.repos ?? [];
  if (!repos.length) return '';
  return dataSection({
    id: 'ms-h', title: 'Merge time by stage', intro: 'How long each stage of a merged PR took: the median, and the time 3 in 4 PRs came in under.',
    cols: [{ label: 'Stage' }, { label: 'Median', num: true }, { label: 'p75', num: true }, { label: 'PRs', num: true }],
    groups: repos.map((r) => ({
      repo: r.name, head: `${r.name} · ${plural(r.prs, 'merged PR')}`,
      rows: MS.STAGES.filter((k) => r.stages?.[k]?.n).map((k) => [esc(MS.STAGE_NAMES[k]), esc(MS.fmt(r.stages[k].median)), esc(MS.fmt(r.stages[k].p75)), String(r.stages[k].n)]),
      note: r.outage ? `${plural(r.outage, 'external review wait')} inside a gate reviewer outage left out of the medians.` : null,
    })),
    fold: repos.map(stagesHeadline),
  });
}

// Merge time by stage and time parked by cause, each closed until opened, with the learned review bar
// between them; a line saying neither has anything yet when that is so.
function mergeAndParking(v) {
  const body = mergeStages(v) + learned(v) + stuckTime(v);
  return `<section aria-labelledby="mp-h" class="stack12"><div class="stack4"><h2 id="mp-h">Merge time and parking</h2><p class="muted small">${body ? 'Each table is closed until you open it, and shows its headline first.' : 'No merged PR has its stages recorded yet, and no ticket has sat parked.'}</p></div>${body}</section>`;
}

// Each repo's asks by arm of a lever weighed on them (question handling, levers-evaluate.mjs): per
// asking ticket, the dollars and tokens of each step, the pushes and digests, the share answered by
// default and the median time to an answer. Nothing until an evaluation has asking tickets.
const usd = (x) => (x == null ? DASH : `$${x.toFixed(2)}`);
const share = (x) => (x == null ? DASH : `${Math.round(x * 100)}%`);
const latency = (s) => (s == null ? DASH : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 60)}m`);
const tokens = (x) => (x == null ? DASH : Math.round(x).toLocaleString('en-US'));
function asksByArm(v) {
  const repos = v.panels.asks?.repos ?? [];
  if (!repos.length) return '';
  const steps = [...new Set(repos.flatMap((r) => Object.values(r.arms).flatMap((a) => Object.keys(a.steps ?? {}))))];
  return dataSection({
    id: 'asks-h', title: 'Questions to you, by arm',
    intro: 'Per asking ticket: what each step of its questions cost, how often it interrupted you, how many applied by default, and how long an answer took.',
    cols: [{ label: 'Arm' }, { label: 'Tickets', num: true }, ...steps.map((k) => ({ label: `${cap(k)} $ (tokens)`, num: true })),
      { label: 'Pushes', num: true }, { label: 'Digests', num: true }, { label: 'Defaulted', num: true }, { label: 'Median to answer', num: true }],
    groups: repos.map((r) => ({
      repo: r.name, head: `${r.name} · ${r.lever} · asking tickets by arm, as of ${String(r.at).slice(0, 10)}`, attrs: ` data-lever="${esc(r.lever)}"`,
      rows: Object.entries(r.arms).map(([a, x]) => [esc(a), String(x.tickets), ...steps.map((k) => `${usd(x.steps?.[k]?.usd_per_ticket)} (${tokens(x.steps?.[k]?.tokens_per_ticket)})`),
        esc(String(x.pushes_per_ticket ?? DASH)), esc(String(x.digests_per_ticket ?? DASH)), share(x.defaulted_share), latency(x.median_latency_s)]),
    })),
  });
}

// Each repo's tickets by arm of a lever that reports handoffs (handoff threshold, levers-evaluate.mjs):
// per ticket, the dollars and the handoffs to a fresh session, the baseline arm first and each other
// value against it. Nothing until an evaluation has tickets.
function handoffsByArm(v) {
  const repos = v.panels.handoffs?.repos ?? [];
  if (!repos.length) return '';
  const vs = (x, b) => (x == null || b == null || !b ? DASH : `${x >= b ? '+' : MINUS}${Math.abs(Math.round((x / b - 1) * 100))}%`);
  return dataSection({
    id: 'handoffs-h', title: 'Handoffs, by threshold',
    intro: 'Per ticket: what it cost and how many times its worker handed off to a fresh session, each threshold against the baseline.',
    cols: [{ label: 'Threshold' }, { label: 'Tickets', num: true }, { label: '$ per ticket', num: true }, { label: 'vs baseline', num: true }, { label: 'Handoffs per ticket', num: true }],
    groups: repos.map((r) => {
      const base = r.arms[r.baseline];
      const order = [...(base ? [r.baseline] : []), ...Object.keys(r.arms).filter((a) => a !== r.baseline)];
      return {
        repo: r.name, head: `${r.name} · ${r.lever} · tickets by threshold, as of ${String(r.at).slice(0, 10)}`, attrs: ` data-lever="${esc(r.lever)}"`,
        rows: order.map((a) => { const x = r.arms[a]; return [esc(a === r.baseline ? `${a} (baseline)` : `${a}%`), String(x.tickets), usd(x.usd_per_ticket),
          a === r.baseline ? DASH : vs(x.usd_per_ticket, base?.usd_per_ticket), esc(String(x.handoffs_per_ticket ?? DASH))]; }),
      };
    }),
  });
}

// Each repo's time parked by cause (stuck-time.mjs), this ISO week and last: the hours, the tickets
// affected and each cause, most hours first, with its tracking issue where one is linked (the column only
// once a cause has one). The stalls come first and the deliberate holds after them, each under its own
// total; a week with no hold has no holds group. Nothing until a ticket has sat stuck.
function stuckTime(v) {
  const repos = v.panels.stuck_time?.repos ?? [];
  if (!repos.length) return '';
  const weeks = repos.flatMap((r) => r.weeks.filter((w) => w.tickets).map((w) => ({ name: r.name, w })));
  const linked = weeks.some(({ w }) => w.causes.some((c) => c.link));
  const issue = (l) => (!l ? DASH : l.url ? `<a href="${esc(l.url)}">${esc(l.ref)}</a>` : esc(l.ref));
  const over = (g) => `${fmtHours(g.hours)} over ${plural(g.tickets, 'ticket')}`;
  const rows = (causes) => causes.map((c) => [esc(c.cause), esc(fmtHours(c.hours)), String(c.tickets), ...(linked ? [issue(c.link)] : [])]);
  const grouped = ({ stalled, held }) => [
    { sub: `Stalled · ${over(stalled)}` }, ...(stalled.causes.length ? rows(stalled.causes) : [{ empty: 'No stalls this week' }]),
    ...(held.causes.length ? [{ sub: `Waiting on purpose · ${over(held)}` }, ...rows(held.causes)] : []),
  ];
  return dataSection({
    id: 'st-h', title: 'Time parked by cause', intro: 'Hours tickets sat parked this week and last, by cause and most hours first, with stalls apart from deliberate holds.',
    cols: [{ label: 'Cause' }, { label: 'Hours', num: true }, { label: 'Tickets', num: true }, ...(linked ? [{ label: 'Tracking issue' }] : [])],
    groups: weeks.map(({ name, w }) => ({
      repo: name, head: `${name} · week ${w.week} · ${over(w)}`,
      rows: w.groups ? grouped(w.groups) : rows(w.causes),
    })),
    // Each repo's latest week with a ticket parked, as its headline: the hours, the tickets and the cause
    // with the most hours.
    fold: repos.filter((r) => r.weeks.some((w) => w.tickets)).map((r) => {
      const i = r.weeks.findIndex((w) => w.tickets);
      const w = r.weeks[i];
      const top = w.causes[0];
      return { repo: r.name, text: `${r.name} ${i === 0 ? 'this week' : 'last week'}: ${fmtHours(w.hours)} parked over ${plural(w.tickets, 'ticket')}${top ? `, the most hours on ${top.cause} (${fmtHours(top.hours)})` : ''}` };
    }),
  });
}

// When desk last kept `lever` in `repo`, from the change list; null when no change records it.
const keptAt = (v, lever, repo) => ((v.panels.changes?.all ?? v.panels.changes?.events ?? [])
  .filter((e) => e.kind === 'transition' && KEPT.includes(e.to) && e.lever === lever && e.repo === repo)
  .map((e) => e.at).sort().pop() ?? null);

// One row per lever: its overall status across repos, and the cell its result is read from. With
// `repo`, the same from that repo's cell and asks alone, and no row for a lever with no cell there.
function leverRows(v, repo = null) {
  const needs = leverItems(v).filter((n) => !repo || n.repo === repo);
  const anyAuto = (v.repos ?? []).some((r) => r.row === 'auto' && (!repo || r.name === repo));
  const order = { kept: 0, testing: 1, needs: 2, pinned: 3, off: 4, error: 5 };
  return (v.panels.board.levers ?? []).flatMap((lever, i) => {
    const l = repo ? { ...lever, cells: lever.cells.filter((c) => c.repo === repo) } : lever;
    if (repo && !l.cells.length) return [];
    const evalCells = l.cells.filter((c) => c.sample);
    const status = needs.some((n) => n.lever === l.lever) ? 'needs'
      : evalCells.some((c) => KEPT.includes(c.state)) ? 'kept'
        : evalCells.some((c) => c.state === 'trial') ? 'testing'
          : l.cells.some((c) => c.state === 'pinned') ? 'pinned'
            : l.cells.length && l.cells.every((c) => c.state === 'error') ? 'error' : 'off';
    const main = [...evalCells].sort((a, b) => (KEPT.includes(b.state) - KEPT.includes(a.state)) || ((b.sample.n ?? -1) - (a.sample.n ?? -1)))[0] ?? null;
    const reg = REGISTRY[l.lever];
    let next;
    if (status === 'pinned') next = `Pinned by hand in ${l.cells.filter((c) => c.state === 'pinned').map((c) => c.repo).join(', ')}, so this is a before-and-after, not a test.`;
    else if (status === 'error') { const e = l.cells.find((c) => c.error)?.error; next = `Couldn’t read ${basename(e?.file)}${e?.line ? ` line ${e.line}` : ''}.`; }
    else if (reg && !reg.trialled) next = reg.layer === 'quality-risk' ? 'Tested one at a time with blind reviews, once desk starts trialling it.' : isValued(reg) ? `Not trialled: on only where levers decide sets it to ${reg.values.join(', ')} in a repo.` : 'Not trialled: on only where a repo’s levers row names it.';
    else if (status === 'off' && l.cells.some((c) => c.state === 'ineligible')) next = `${cap(l.cells.filter((c) => c.state === 'ineligible').map((c) => c.note).join('. '))}.`;
    else next = anyAuto ? 'Testing starts with the next tickets desk admits.' : 'Testing starts when a repo is set to auto.';
    const decided = status === 'kept' && main ? keptAt(v, l.lever, main.repo) : null;
    const asks = needs.filter((n) => n.lever === l.lever);
    return [{ lever: l.lever, layer: l.layer, cells: l.cells, status, main, next, decided, asks, i, rank: order[status] }];
  }).sort((a, b) => a.rank - b.rank || a.i - b.i);
}

const repoWord = (c, tz) => {
  if (c.state === 'error') return { t: `${c.repo}: ${DASH}, couldn’t read`, c: C.grey };
  if (c.turned_off_at) return { t: `${c.repo}: turned off by desk, ${dayMonth(c.turned_off_at, tz)}`, c: C.grey };
  if (KEPT.includes(c.state)) return { t: `${c.repo}: kept`, c: C.green };
  if (c.state === 'trial') return { t: `${c.repo}: testing`, c: C.blue };
  if (c.state === 'pinned') return { t: `${c.repo}: on by hand`, c: C.green };
  if (c.state === 'not_enrolled') return { t: `${c.repo}: not enrolled`, c: C.grey };
  // The short status in the cell, the precondition's rationale on hover.
  if (c.state === 'ineligible') return { t: `${c.repo}: not tested, ${c.status ?? c.why}`, c: C.grey, title: c.why };
  return { t: `${c.repo}: ${String(c.state ?? 'off').replace(/_/g, ' ')}`, c: C.grey };
};

// The result so far: a colour and a direction word only once the view gives a verdict.
function result(row) {
  const c = row.main;
  if (!c?.effect) return { text: DASH, ink: C.grey, notes: [] };
  const e = c.effect;
  const metric = REGISTRY[row.lever]?.mechanism?.metric ?? e.metric ?? '';
  let text = cap(e.label);
  let ink = C.greyInk;
  if (e.verdict === 'better') { if (e.est != null && e.unit === 'ratio') text = `${Math.round(Math.abs(e.est) * 100)}% lower ${metric}`; ink = C.ink; }
  else if (e.verdict === 'worse') ink = C.amberInk;
  const range = e.lo90 != null && e.hi90 != null ? `90% range ${signed(e.lo90)} to ${signed(e.hi90)}` : 'No range recorded';
  const plain = plainWords(c);
  return { text, ink, notes: [...(plain ? [plain] : []), `${range} · n ${e.n ?? 'not recorded'}`], verdict: e.verdict };
}

// The cost and guardrails of a cell in plain words, from the view's own labels and statuses:
// "Cost not worse than off, saves $0.18–$1.75 a ticket, nothing worse". Empty while both are too early.
function plainWords(c) {
  const parts = [];
  if (c.cost?.verdict) parts.push(`cost ${c.cost.label}`);
  const s = c.cost?.saving_usd;
  if (s && s.lo != null && s.hi != null) parts.push(`saves $${s.lo.toFixed(2)}–$${s.hi.toFixed(2)} a ticket`);
  const gs = (c.guardrails ?? []).map((g) => g.status);
  const watching = gs.filter((g) => g === 'watching').length;
  if (gs.includes('breached')) parts.push('a guardrail breached');
  else if (watching) parts.push(`${plural(watching, 'guardrail')} being watched`);
  else if (gs.length && gs.every((g) => g === 'ok')) parts.push('nothing worse');
  return cap(parts.join(', '));
}

function progress(row, tz) {
  if (row.status === 'kept') return { pct: 100, text: row.decided ? `Decided ${dayMonth(row.decided, tz)}` : 'Decided' };
  if (row.status === 'needs') {
    const at = row.asks.map((a) => a.at).filter((x) => x && !Number.isNaN(Date.parse(x))).sort()[0];
    return { pct: 0, text: at ? `Waiting on you since ${when(at, tz)}` : 'Waiting on you', wait: true };
  }
  const s = row.main?.sample;
  if (!s) return { pct: 0, text: 'Not started' };
  if (s.n == null) return { pct: 0, text: `Sample not recorded · needs ${s.min}` };
  return { pct: Math.min(100, Math.round((s.n / s.min) * 100)), text: `${s.n} of ${s.min} tickets` };
}

// ---- the decision under a lever waiting on you -----------------------------------------------------------------
// What keeping a lever off means for a repo's tickets, before " in <repo>".
const OFF = Object.freeze({
  preflight: 'Every worker runs the start-up check',
  wrappers: 'Workers run often-blocked commands directly',
  memory: 'Workers start with full memory',
  'failure-class': 'A ticket whose CI failed for a machine reason is not rerun on its own',
  'review-reuse': 'Every rebase is reviewed again in full',
  codex: 'Claude reviews pull requests',
  effort: 'Every step uses the usual thinking',
  'finder-model': 'Finders stay on their usual model',
  ledger: 'Queue changes are not logged beside queue.json',
  'ledger-record': 'queue.json is not restored from the ticket log',
});
const idPart = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '-');
const decideId = (a) => `decide-${idPart(a.lever)}-${idPart(a.repo)}`;
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

// One choice of `a` (a needs-you item), as its title, what it does and its command with a Copy button.
function choiceCard(row, a, { choice, command }) {
  let title;
  let does;
  if (choice === 'off') {
    title = 'Keep it off';
    does = `${OFF[row.lever] ?? `${cap(row.lever)} stays off`} in ${a.repo}. You can test it again whenever you like.`;
  } else if (choice === 'trial') {
    title = 'Test it again';
    const times = a.reverts === 1 ? ' This is the first time desk turned it off.' : a.reverts > 1 ? ` desk has turned it off ${a.reverts} times.` : '';
    does = `Starts a new test${a.min ? ` at 0 of ${a.min} tickets` : ''}.${times}${a.freezes_next ? ' If desk turns it off again, it stays off until you turn it back on.' : ''}`;
  } else if (choice === a.baseline) {
    title = `Keep it on ${choice}`;
    does = `Every ticket in ${a.repo} runs on ${choice}, as it does with no test. You can test it again whenever you like.`;
  } else {
    title = `Set it to ${choice}`;
    does = `Every ticket in ${a.repo} runs on ${choice}.`;
  }
  const label = `Copy the ${title.toLowerCase().replace(/\s+/g, '-')} command`;
  return `<div class="choice" data-choice="${esc(choice)}"><div class="stack4"><span class="choice-h">${esc(title)}</span><span class="choice-d">${esc(does)}</span></div>`
    + `<div class="choice-cmd"><code class="mono cmd">${esc(command)}</code><button type="button" class="copy" data-copy="${esc(command)}" data-label="${esc(label)}" aria-label="${esc(label)}">Copy</button></div></div>`;
}

// The panel under a lever's row for each needs-you item on it: why desk is asking, the evidence, each
// choice with its command, and what holds until the person chooses.
// The question a needs-you item asks, as plain text.
function askHead(a) {
  if (!a.lever) return sentence(cap(a.text ?? 'A lever needs your decision'));
  if (!a.turned_off) return `${a.lever} in ${a.repo} needs your decision.`;
  return a.baseline ? `desk set ${a.lever} back to ${a.baseline} in ${a.repo}. Keep it there, or test it again?`
    : `desk turned ${a.lever} off in ${a.repo}. Keep it off, or test it again?`;
}

function decisionPanel(row, a) {
  const lever = esc(row.lever);
  const head = esc(askHead({ ...a, lever: row.lever }));
  const why = a.step && a.ticket
    ? `On ${esc(a.ticket)} a worker ran a command that included <span class="key">${esc(a.step.step)}</span>, and the command exited ${esc(a.step.exit)}. desk counts that as the lever’s own step failing, so it turned the lever off. Nothing about ${row.layer === 'quality-risk' ? 'review quality' : 'what it saves'} was measured.`
    : a.text ? esc(sentence(cap(a.text))) : '';
  const ev = a.evidence ? `<p class="muted tiny">Evidence: <span class="mono">${esc(a.evidence.file)}</span>${a.evidence.line != null ? `, line ${esc(a.evidence.line)}` : ''}</p>` : '';
  const until = a.turned_off ? `Until you choose, ${lever} stays ${a.baseline ? `on ${esc(a.baseline)}` : 'off'}. ` : '';
  const id = decideId(a);
  return `<div class="decide" id="${id}"${repoAttr(a.repo)} role="region" aria-labelledby="${id}-h"><div class="stack4"><h3 class="decide-h" id="${id}-h">${head}</h3>${why ? `<p class="decide-why">${why}</p>` : ''}${ev}</div>`
    + `<div class="choices">${a.choices.map((c) => choiceCard(row, a, c)).join('')}</div>`
    + `<p class="muted tiny">${until}Run ${a.choices.length === 2 ? 'either command' : 'one of these commands'} in a terminal, and this row updates on the next refresh.</p></div>`;
}

function leverTable(v, today) {
  const p = v.panels.board;
  const rows = leverRows(v);
  // With a repo filter, each row also carries what it reads in each repo, and shows only in the repos
  // it has a cell in; the filter shows the picked repo's reading in place of the one across repos.
  const names = repoNames(v);
  const inRepo = new Map(names.map((n) => [n, new Map(leverRows(v, n).map((r) => [r.lever, r]))]));
  const per = (r, f) => (names.length
    ? `<div data-all>${f(r)}</div>${names.filter((n) => inRepo.get(n).has(r.lever)).map((n) => `<div${repoAttr(n)} data-reading hidden>${f(inRepo.get(n).get(r.lever))}</div>`).join('')}`
    : f(r));
  const repos = (cells) => (names.length ? ` data-repos="${esc([...new Set(cells.map((c) => c.repo))].join(' '))}"` : '');
  const badge = (s) => `<span class="badge" style="${STYLE[s].badge}"><span class="dot" style="background:${STYLE[s].dot}"></span>${STYLE[s].label}</span>`;
  const name = (r, audited) => `<td class="td"><div class="stack3"><span class="b">${esc(r.lever)}</span><span class="muted small">${esc(WHAT[r.lever] ?? '')}</span>${audited && r.layer === 'quality-risk' ? '<span class="tiny" style="color:#4B5563">Each change checked by a blind review after merge</span>' : ''}</div></td>`;
  const stale = p.state === 'stale' && p.age ? `<div role="status" class="note"><span class="dot" style="background:${C.amber};margin-top:6px"></span><span>No new results for ${esc(p.age.words.replace(/ ago$/, ''))}. These are from ${esc(since(p.age.as_of, v.tz))}.</span></div>` : '';
  let head;
  let body;
  let intro;
  if (today) {
    intro = 'No lever is being tested yet, so there are no results. Here’s where each one stands.';
    head = '<tr><th class="th" style="width:34%">Lever</th><th class="th" style="width:18%">Status</th><th class="th">What happens next</th></tr>';
    body = rows.map((r) => `<tr data-lever="${esc(r.lever)}"${repos(r.cells)}>${name(r, false)}<td class="td">${per(r, (x) => badge(x.status))}</td><td class="td muted small next">${per(r, (x) => esc(x.next))}</td></tr>`).join('');
  } else {
    intro = 'One row per lever. Testing means it’s on for half of new tickets, so desk can compare the two halves.';
    head = '<tr><th class="th" style="width:26%">Lever</th><th class="th" style="width:15%">Status</th><th class="th" style="width:20%">Result so far</th><th class="th" style="width:17%">Progress to a decision</th><th class="th">By repo</th></tr>';
    const resultHtml = (x) => {
      const res = result(x);
      return `<div class="stack3"><span class="b result" data-verdict="${esc(res.verdict ?? 'none')}" style="color:${res.ink}">${esc(res.text)}</span>${res.notes.map((n) => `<span class="muted tiny">${esc(n)}</span>`).join('')}</div>`;
    };
    const progressHtml = (x) => {
      const pr = progress(x, v.tz);
      return `<div class="stack6"><div class="bar${pr.wait ? ' bar-wait' : ''}" role="img" aria-label="${esc(pr.text)}"><div style="width:${pr.pct}%"></div></div><span class="${pr.wait ? 'wait' : 'muted'} tiny">${esc(pr.text)}</span></div>`;
    };
    body = rows.map((r) => {
      const asks = r.status === 'needs' ? r.asks.filter((a) => a.choices) : [];
      return `<tr data-lever="${esc(r.lever)}"${repos(r.cells)}${r.status === 'needs' ? ' class="needs"' : ''}>${name(r, true)}<td class="td">${per(r, (x) => badge(x.status))}</td>`
        + `<td class="td num">${per(r, resultHtml)}</td><td class="td num">${per(r, progressHtml)}</td>`
        + `<td class="td small"><div class="stack4">${r.cells.map((c) => { const w = repoWord(c, v.tz); return `<span class="repo"${repoAttr(c.repo)}${w.title ? ` title="${esc(w.title)}"` : ''}><span class="dot dot-sm" style="background:${w.c}"></span><span>${esc(w.t)}${c.stale ? ' · stale' : ''}</span></span>`; }).join('')}</div></td></tr>`
        + (asks.length ? `<tr class="decide-row"${repos(asks)}><td colspan="5" class="decide-cell"><div class="stack12">${asks.map((a) => decisionPanel(r, a)).join('')}</div></td></tr>` : '');
    }).join('');
  }
  const legend = today ? '' : `<div class="legend-row muted tiny">${['kept', 'testing', 'needs', 'off'].map((s) => `<span><span class="dot" style="background:${STYLE[s].dot}"></span>${s === 'off' ? 'Off or waiting' : STYLE[s].label}</span>`).join('')}</div>`;
  return `<section aria-labelledby="lev-h" class="card levers"><div class="levers-head"><div class="stack4"><h2 id="lev-h">Is each lever working?</h2><p class="muted small">${intro}</p></div>${legend}${notes(p)}${stale}</div>
<table class="levtable${today ? ' today' : ''}"><thead>${head}</thead><tbody>${body}</tbody></table></section>`;
}

// ---- the change list ---------------------------------------------------------------------------------------------
const you = (e) => e.actor && !['controller', 'supervisor', 'desk'].includes(e.actor);
function changeWhat(e) {
  // A change the view merged from one per lever names every lever it was recorded for.
  const many = (e.levers?.length ?? 0) > 1;
  const lever = many ? andList(e.levers) : e.lever ?? 'a lever';
  const where = e.repo && e.repo !== '*' ? ` in ${e.repo}` : '';
  switch (e.kind) {
    case 'transition':
      if (e.to === 'trial') return `Started testing ${lever}${where}`;
      if (KEPT.includes(e.to)) return `Kept ${lever}${where}`;
      if (e.to === 'paused') return `Paused ${lever}${where}`;
      if (['off', 'reverted', 'none'].includes(e.to)) return `Turned off ${lever}${where}`;
      return `${cap(lever)}${where} moved from ${e.from ?? 'unknown'} to ${e.to ?? 'unknown'}`;
    case 'trip': return `Turned off ${lever}${where}`;
    case 'ramp': return `${cap(lever)} now on for ${typeof e.to === 'number' ? `${Math.round(e.to * 100)}%` : e.to ?? 'more'} of${where ? where.replace(' in ', ' ') : ''} tickets`;
    case 'override': return `${you(e) ? 'You' : 'Someone'} set ${lever}${e.to ? ` to ${e.to}` : ' by hand'}${where}`;
    case 'freeze': return `Trials frozen${where || ' in every repo'}`;
    case 'thaw': return `Trials thawed${where || ' in every repo'}`;
    case 'row_change': return `The levers row${where} changed${e.from != null && e.to != null ? ` from ${e.from} to ${e.to}` : ''}`;
    case 'fp_reset': return many ? `The code of ${lever} changed${where}, so their evidence started again` : `${cap(lever)}’s code changed${where}, so its evidence started again`;
    case 'evidence_incomplete': return `Evidence for ${lever}${where} was incomplete`;
    default: return `${cap(e.kind ?? 'change')}${e.lever ? ` to ${lever}` : ''}${where}`;
  }
}

const notRecorded = '<span class="muted">not recorded</span>';
const interval = (x) => (x?.lo90 != null && x?.hi90 != null ? `90% range ${signed(x.lo90)} to ${signed(x.hi90)}` : 'no range recorded');
// An expanded change: its reason, the tickets per arm, the mechanism and cost intervals, each guardrail,
// the commit range and the evidence file, from the evaluation it cites.
function changeDetails(e) {
  const ev = e.evidence;
  const reason = e.wording || e.reason ? `${esc(cap(e.wording ?? e.reason))}${e.reason_code ? ` <span class="mono tiny muted">${esc(e.reason_code)}</span>` : ''}` : notRecorded;
  const [onArm, offArm] = (ev?.n?.arms ?? ['on', 'off']).map((a) => esc(String(a)));
  const arms = ev?.n && (ev.n.on != null || ev.n.off != null) ? `${ev.n.on ?? DASH} ${onArm}, ${ev.n.off ?? DASH} ${offArm}` : notRecorded;
  const mech = ev?.effect ? `${esc(cap(ev.effect.label))}, ${esc(interval(ev.effect))}${ev.effect.est != null ? `, estimate ${signed(ev.effect.est)}` : ''}` : notRecorded;
  const cost = ev?.cost ? `${esc(cap(ev.cost.label))}, ${esc(interval(ev.cost))}, margin ${signed(ev.cost.margin)}` : notRecorded;
  const guards = ev?.guardrails?.length
    ? `<ul class="guards">${ev.guardrails.map((g) => `<li><span class="b">${esc(String(g.name ?? 'guardrail').replace(/_/g, ' '))}</span>: ${esc(String(g.status).replace(/_/g, ' '))}, ${esc(interval(g))}${g.margin != null ? `, margin ${signed(g.margin)}` : ''}</li>`).join('')}</ul>`
    : notRecorded;
  const row = (k, val) => `<dt>${k}</dt><dd>${val}</dd>`;
  return `<dl class="change-dl">${row('Reason', reason)}${row('Tickets per arm', arms)}${row('Mechanism', mech)}${row('Cost', cost)}${row('Guardrails', guards)}`
    + `${row('Commit range', e.desk_commit_range ? `<span class="mono">${esc(e.desk_commit_range)}</span>` : notRecorded)}`
    + `${row('Evidence file', e.evidence_file ? `<span class="mono">${esc(e.evidence_file)}</span>` : notRecorded)}`
    + `${e.ticket ? row('Ticket', esc(e.ticket)) : ''}`
    + `${e.missing?.length ? row('Not recorded', `<ul class="guards">${e.missing.map((g) => `<li>${esc(cap(g.what))}: ${esc((g.tickets ?? g.files ?? []).join(', '))}</li>`).join('')}</ul>`) : ''}</dl>`;
}

// The line under a change: its reason as written, which may be typed by a person or carry a value (a row's
// new reading, an arm set by hand); only a reason desk wrote for the log (incomplete evidence, a lever's
// code changing, anything naming missing files) gives way to its reason code's wording.
const MACHINE_REASONS = Object.freeze(['evidence_incomplete', 'fp_reset']);
const shownReason = (e) => (MACHINE_REASONS.includes(e.kind) || e.missing ? e.wording ?? e.reason : e.reason ?? e.wording);

// ---- the change log: changes no test can split, with the tickets either side ------------------------------------
const LOG_KIND = Object.freeze({ pr: { label: 'Merged PR', word: 'PR' }, config: { label: 'Settings', word: 'setting' }, claude: { label: 'Claude version', word: 'version' } });
const MIN_SIDE = 5;
const rowItems = (x) => (x == null ? 'none' : (Array.isArray(x) ? x : [x]).join(' ') || 'none');

// A change log entry's title and the muted line under it.
function logHead(e) {
  const where = e.repo ? ` · ${e.repo}` : '';
  if (e.kind === 'pr') {
    const what = e.pr != null ? `PR #${e.pr}` : `Commit ${String(e.sha ?? '').slice(0, 7) || 'with no PR'}`;
    return { title: e.title ?? 'Untitled commit', meta: `${what}${e.ticket ? ` · ${e.ticket}` : ''}${where}` };
  }
  // `row` is "§<section> <label>": the label titles it, the whole row names it under the title.
  if (e.kind === 'config') {
    const label = cap(String(e.row ?? 'A config').replace(/^§\S+\s*/, ''));
    return { title: `${label} row${e.repo ? ` in ${e.repo}` : ''}: ${rowItems(e.from)} to ${rowItems(e.to)}`, meta: `Config ${e.row ?? ''}${where}` };
  }
  return { title: e.from ? `Claude Code ${e.from} to ${e.to}` : `Claude Code ${e.to}`, meta: `First worker start on the new version${where}` };
}

// "Too early" with the count while either side has fewer than MIN_SIDE tickets; null once both have.
function tooEarly(e) {
  const b = e.before?.accepted ?? 0;
  const a = e.after?.accepted ?? 0;
  if (b >= MIN_SIDE && a >= MIN_SIDE) return null;
  const count = b >= MIN_SIDE ? `${plural(a, 'ticket')} since` : a >= MIN_SIDE ? `${plural(b, 'ticket')} before it` : `${b} before and ${a} since`;
  return `Too early: ${count}. Figures show once there are ${MIN_SIDE} on each side.`;
}

// One side's cost and blind review figures, as the before-and-after table and the chart tooltips word them.
const sideCost = (s) => (s?.median_usd == null ? null : usd(s.median_usd));
const sideCostCell = (s) => (sideCost(s) == null ? notRecorded : `${sideCost(s)} · ${plural(s.costed, 'ticket')}`);
const sideAuditCell = (s) => (!s?.audited ? notRecorded : `P0 ${s.p0} · P1 ${s.p1} · P2 ${s.p2} · ${plural(s.audited, 'review')}`);

function beforeAfter(e) {
  const days = e.window_days;
  const col = (side) => (days ? `${plural(days, 'day')} ${side}` : cap(side));
  const row = (label, f) => `<tr><th scope="row">${label}</th><td class="mono">${f(e.before)}</td><td class="mono">${f(e.after)}</td></tr>`;
  return `<div class="ba"><table class="ba-t"><thead><tr><td></td><th scope="col">${col('before')}</th><th scope="col">${col('after')}</th></tr></thead><tbody>`
    + `${row('Cost per ticket', sideCostCell)}${row('Blind review findings per PR', sideAuditCell)}</tbody></table>`
    + `<p class="muted tiny">Before and after, not a test. Other changes landed in the same days, so this can’t show the ${LOG_KIND[e.kind]?.word ?? 'change'} caused the difference.</p></div>`;
}

function logEntry(e, tz) {
  const h = logHead(e);
  const early = tooEarly(e);
  return `<div class="change-log" data-kind="other"${repoAttr(e.repo)} id="change-${e.n}"><span class="muted num small when">${esc(when(e.at, tz))}</span><div class="stack6">`
    + `<div class="change-title"><span class="n-badge num" aria-label="Change ${e.n}">${e.n}</span><span class="kind">${esc(LOG_KIND[e.kind]?.label ?? 'Change')}</span><span class="b">${esc(h.title)}</span></div>`
    + `<span class="muted small">${esc(h.meta)}</span>${early ? `<p class="small too-early">${esc(early)}</p>` : beforeAfter(e)}</div></div>`;
}

const leverEntry = (e, tz) => `<details class="change" data-kind="lever"${repoAttr(e.repo)}><summary><span class="muted num small when">${esc(when(e.at, tz))}</span><span class="stack3"><span class="change-title"><span class="kind kind-lever">Lever</span><span class="b">${esc(changeWhat(e))}</span></span>${shownReason(e) ? `<span class="muted small">${esc(cap(shownReason(e)))}</span>` : ''}</span></summary>${changeDetails(e)}</details>`;

// Every change, newest first: what desk changed in its lever tests, and the merged PRs, settings and
// Claude versions from the change log, each numbered as its line on the trend charts.
function changes(v) {
  const p = v.panels.changes;
  const log = v.panels.change_log;
  const tz = v.tz;
  const list = [
    ...(p.all ?? p.events ?? []).map((e) => ({ at: e.at, html: () => leverEntry(e, tz) })),
    ...(log?.entries ?? []).map((e) => ({ at: e.at, html: () => logEntry(e, tz) })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const pick = `<div role="group" aria-label="Kind of change" class="toggle"><button type="button" data-pick-kind="" aria-pressed="true">All</button><button type="button" data-pick-kind="lever" aria-pressed="false">Lever changes</button><button type="button" data-pick-kind="other" aria-pressed="false">Other changes</button></div>`;
  const head = `<div class="sec-head"><div class="stack4"><h2 id="ch-h">Every change</h2><p class="muted small sub">Newest first. Lever changes come from tests. Other changes can’t be tested, so each shows the tickets before and after it. Numbers match the lines on the charts.</p></div>${list.length ? pick : ''}</div>`;
  const body = list.length
    ? `${list.map((x) => x.html()).join('')}<p class="empty ch-none" hidden>No change of this kind${(v.repos?.length ?? 0) > 1 ? ' in this repo' : ''}. Pick All to see every change.</p>`
    : '<p class="empty">Nothing has changed how desk works yet.</p>';
  return `<section aria-labelledby="ch-h" class="card changes">${head}${notes(p)}${notes(log)}${body}</section>`;
}

const howDesk = () => `<section aria-labelledby="how-h" class="how"><h2 id="how-h">How desk decides</h2><p class="muted small">A lever being tested is on for half of new tickets and off for the other half. Once ${DECISION_RULE.min_per_arm['low-risk']} tickets on each side have finished, desk keeps the lever if those tickets cost less and nothing got worse: tickets accepted, fix tries, failed checks and reverts. Otherwise it turns the lever off. Riskier levers are tried on fewer tickets first, and each of their changes gets a blind review after merge. A lever turned off twice is paused until you decide.</p></section>`;

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#F9FAFB;color:#111827;font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;overflow-wrap:anywhere}
a{color:#111827}a:hover{color:#374151}
h1,h2,h3,p{margin:0}
.num{font-variant-numeric:tabular-nums}
.mono{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
.card{background:#FFFFFF;border:1px solid #E5E7EB;border-radius:8px}
.muted{color:#6B7280}.small{font-size:13px}.tiny{font-size:12px}.b{font-weight:600}.amber{color:#B45309;font-weight:600}
.badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}.dot-sm{width:6px;height:6px}
.key{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;background:#F3F4F6;padding:1px 6px;border-radius:4px}
.key-dark{background:#374151;color:#F9FAFB}
.stack3{display:flex;flex-direction:column;gap:3px}.stack4{display:flex;flex-direction:column;gap:4px}.stack6{display:flex;flex-direction:column;gap:6px}.stack12{display:flex;flex-direction:column;gap:12px}
.page{padding:32px 24px 64px}
.wrap{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:28px}
#page-body{display:flex;flex-direction:column;gap:28px}
body[data-age=old] #page-body{filter:grayscale(1);opacity:.55}
.top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px}
.top h1{font-size:28px;font-weight:700;letter-spacing:-.01em}
.top p{font-size:15px}
.updated{font-size:13px}
.banner{padding:14px 16px;border-radius:8px;display:flex;flex-direction:column;gap:4px}
.banner-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600}
.banner-body{font-size:13px;line-height:1.45}
.banner-stale{background:#FFFBEB;border:1px solid #FCD34D}.banner-stale .banner-title,.banner-stale .banner-body{color:#92400E}
.banner-old{background:#111827}.banner-old .banner-title{color:#F9FAFB}.banner-old .banner-body{color:#E5E7EB}
#age-banner:empty{display:none}
[hidden]{display:none!important}
[id]{scroll-margin-top:16px}
.shell{max-width:1420px;margin:0 auto;display:grid;grid-template-columns:200px minmax(0,1fr);gap:32px;align-items:start}
.side{position:sticky;top:24px;display:flex;flex-direction:column;gap:8px}
.side-h{padding:0 10px}
.side ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.side a{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:0 10px;border-radius:6px;font-size:14px;color:#374151;text-decoration:none}
.side a:hover{background:#F3F4F6;color:#111827}
.nav-n{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;font-size:12px;font-weight:600}
.nav-amber{background:#FEF3C7;color:#92400E}.nav-blue{background:#DBEAFE;color:#1E40AF}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chips button{min-height:36px;padding:0 14px;border:1px solid #D1D5DB;border-radius:999px;background:#FFFFFF;color:#374151;font:500 13px Inter,system-ui,sans-serif;cursor:pointer}
.chips button[aria-pressed=true]{background:#111827;border-color:#111827;color:#F9FAFB}
.needs-box{padding:16px 18px;background:#FFFBEB;border-color:#FCD34D;display:flex;flex-direction:column;gap:12px}
.needs-label{font-size:13px;font-weight:600;color:#92400E}
.needs-item{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
.needs-q{font-size:16px;line-height:1.45;max-width:760px}
.lede{font-size:15px;line-height:1.5;color:#374151;max-width:820px}.lede b{font-weight:600}
.cta{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:6px;background:#111827;color:#F9FAFB;font-size:14px;font-weight:500;text-decoration:none}
.cta:hover{color:#F9FAFB;background:#374151}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(250px,100%),1fr));gap:16px}
.tile{padding:16px;display:flex;flex-direction:column;gap:10px;min-height:150px}
.tile h3{font-size:14px;font-weight:500}
.tile-v{font-size:34px;font-weight:600;letter-spacing:-.02em;line-height:1}
.tile-s{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500}
.tile-sub{font-size:12px}
.spark{margin-top:auto}
.sec-head{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px}
h2{font-size:17px;font-weight:600}
.toggle{display:inline-flex;border:1px solid #D1D5DB;border-radius:6px;overflow:hidden}
.toggle button{min-height:36px;padding:0 14px;border:0;background:#FFFFFF;color:#374151;font:500 13px Inter,system-ui,sans-serif;cursor:pointer}
.toggle button+button{border-left:1px solid #D1D5DB}
.toggle button[aria-pressed=true]{background:#111827;color:#F9FAFB}
button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid #111827;outline-offset:2px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(540px,100%),1fr));gap:16px}
.wbr{padding:16px 16px 0;display:flex;flex-direction:column;border-radius:12px;min-width:0}
.wbr-head{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;margin-bottom:2px}
.wbr-head h3{font-size:16px;font-weight:700;text-align:center}
.wbr-rag{display:flex;justify-content:flex-end}
.rag{width:14px;height:14px;border-radius:50%;display:inline-block}.rag-sm{width:12px;height:12px}
.wbr-sub{font-size:12px;text-align:center}
.chart{position:relative;width:100%;aspect-ratio:700/340;overflow:hidden}
.chart svg{display:block;position:absolute;inset:0}
.chart-labels{position:absolute;inset:0;font-size:10px;line-height:1;pointer-events:none}
.chart-labels span{position:absolute;white-space:nowrap}
.legend{position:absolute;left:0;right:0;bottom:2px;display:flex;justify-content:center;gap:20px;font-size:10px;color:#6B7280}
.legend>span{display:flex;align-items:center;gap:5px}.swatch{width:20px;height:2px;display:inline-block}
.swatch-dash{height:0;border-top:1px dashed #6B7280}
.marks{position:absolute;inset:0;pointer-events:none}
.mark{position:absolute;top:0;bottom:0;width:0}
.mark::before{content:'';position:absolute;left:0;top:12%;bottom:16%;border-left:1px dashed #6B7280}
.mark:focus{outline:none}
.mark-n{position:absolute;left:0;transform:translateX(-50%);width:16px;height:16px;border:1px solid #6B7280;border-radius:50%;background:#FFFFFF;color:#374151;font-size:10px;font-weight:600;line-height:14px;text-align:center;pointer-events:auto;cursor:default}
.mark:hover .mark-n,.mark:focus .mark-n{background:#111827;border-color:#111827;color:#F9FAFB}
.mark:focus-visible .mark-n{outline:2px solid #111827;outline-offset:2px}
.mark-tip{display:none;position:absolute;top:24px;left:6px;width:max-content;max-width:240px;padding:10px 12px;border-radius:6px;background:#111827;color:#F9FAFB;flex-direction:column;gap:4px;white-space:normal;z-index:2}
.mark-r .mark-tip{left:auto;right:6px}
.mark:hover .mark-tip,.mark:focus .mark-tip{display:flex}
.mark-note{color:#D1D5DB}
.callouts{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));border-top:1px solid #E5E7EB;margin:4px -16px 0}
.callout{display:flex;flex-direction:column;text-align:center;border-right:1px solid #E5E7EB}
.callout:last-child{border-right:0}
.callout-l{padding:6px 2px 2px;font-size:12px;font-weight:500;color:#6B7280}
.callout-v{padding:6px 2px 10px;font-size:12px}
.awaiting{padding:16px;display:flex;flex-direction:column}
.awaiting-head{display:flex;justify-content:space-between;align-items:center}.awaiting-head h3{font-size:16px;font-weight:500}
.awaiting-body{height:200px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;text-align:center}
.levers{overflow:hidden}
.levers-head{padding:18px 16px 14px;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px;border-bottom:1px solid #E5E7EB}
.legend-row{display:flex;gap:14px;flex-wrap:wrap}.legend-row span{display:flex;align-items:center;gap:6px}
.levtable{width:100%;border-collapse:collapse}
.th{font-size:12px;font-weight:500;color:#6B7280;text-align:left;padding:10px 16px;border-bottom:1px solid #E5E7EB}
.td{padding:14px 16px;border-bottom:1px solid #F0F1F3;vertical-align:top;font-size:14px}
.scroll{overflow-x:auto}
.levtable.data{min-width:560px}
.levtable .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.levtable th.td{text-align:left;font-weight:500}
.levtable .grp{background:#F9FAFB;padding:9px 16px;font-size:13px;font-weight:600;color:#374151;border-bottom:1px solid #E5E7EB}
.levtable th.sgrp{padding:8px 16px 6px;font-size:12px;font-weight:600;color:#6B7280}
.levtable tr:last-child>.td{border-bottom:0}
.bar{height:6px;border-radius:3px;background:#F0F1F3}.bar div{height:6px;border-radius:3px;background:#111827}
.bar.bar-wait{background:#FDE68A}.wait{color:#92400E;font-weight:500}
.levtable tr.needs,.levtable tr.decide-row{background:#FFFBEB}.levtable tr.needs>.td{border-bottom:0}
.levtable .decide-cell{padding:0 16px 18px;border-bottom:1px solid #F0F1F3}.levtable tr:last-child>.decide-cell{border-bottom:0}
.decide{display:flex;flex-direction:column;gap:14px;padding:16px;background:#FFFFFF;border:1px solid #FCD34D;border-radius:8px}
.decide-h{font-size:15px;font-weight:600}
.decide-why{font-size:13px;line-height:1.5;color:#374151;max-width:860px}
.choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:12px}
.choice{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid #E5E7EB;border-radius:6px}
.choice-h{font-size:14px;font-weight:600}.choice-d{font-size:13px;line-height:1.45;color:#4B5563}
.choice-cmd{display:flex;align-items:center;gap:8px;margin-top:auto}
.cmd{flex:1;min-width:0;font-size:12px;background:#F3F4F6;padding:9px 10px;border-radius:4px;overflow-x:auto;white-space:nowrap}
.copy{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 12px;border:1px solid #D1D5DB;border-radius:6px;background:#FFFFFF;color:#374151;font:500 13px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}
.copy:hover{background:#F3F4F6}
.repo{display:flex;align-items:center;gap:6px}
.note{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:#FFFBEB;border:1px solid #FCD34D;border-radius:6px;font-size:13px;line-height:1.45;color:#92400E;width:100%}
.note-path{display:block;font-size:12px;margin-top:2px}
.changes{padding:18px 16px;display:flex;flex-direction:column;gap:4px}
.changes h2{margin-bottom:2px}.changes .sub{margin-bottom:6px}
.change{border-top:1px solid #F0F1F3}
.change summary{display:grid;grid-template-columns:110px minmax(0,1fr);gap:14px;padding:12px 0;cursor:pointer;list-style:none;align-items:start}
.change summary::-webkit-details-marker{display:none}
.change .when{padding-top:2px}
.change-dl{display:grid;grid-template-columns:150px minmax(0,1fr);gap:8px 14px;margin:0 0 14px 124px;font-size:13px}
.change-dl dt{font-size:12px;font-weight:500;color:#6B7280;padding-top:1px}.change-dl dd{margin:0}
.guards{margin:0;padding-left:18px}
.change-title{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.kind{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:#F3F4F6;color:#374151;font-size:11px;font-weight:500;white-space:nowrap}
.kind-lever{background:#DBEAFE;color:#1E40AF}
.n-badge{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border:1px solid #111827;border-radius:50%;font-size:11px;font-weight:600}
.change-log{display:grid;grid-template-columns:110px minmax(0,1fr);gap:14px;padding:12px 0;border-top:1px solid #F0F1F3}
.change-log .when{padding-top:2px}
.too-early{color:#374151}
.ba{display:flex;flex-direction:column;gap:6px;max-width:720px;padding:12px;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:6px;overflow-x:auto}
.ba-t{border-collapse:collapse;font-size:13px}
.ba-t th,.ba-t td{padding:3px 24px 3px 0;text-align:left;vertical-align:top;font-weight:400}
.ba-t thead th{font-size:12px;font-weight:500;color:#6B7280}
.ba-t tbody th{color:#374151}.ba-t td.mono{font-size:12px}
.fold-sum{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;row-gap:4px;align-items:center;cursor:pointer;list-style:none}
.fold-sum::-webkit-details-marker{display:none}
.fold:not([open])>.fold-sum{border-bottom:0}
.fold-lines{grid-column:1}
.fold-line{display:block}
.fold-cue{grid-column:2;grid-row:1/span 2;font-weight:500;color:#374151;white-space:nowrap}
.fold-hide,.fold[open] .fold-show{display:none}.fold[open] .fold-hide{display:inline}
.fold-intro{padding:12px 16px 4px}
.empty{padding:12px 0;border-top:1px solid #F0F1F3;font-size:14px}
.how{display:flex;flex-direction:column;gap:6px;padding:0 4px}.how h2{font-size:14px}.how p{max-width:820px;line-height:1.55}
@media (max-width:640px){
.page{padding:24px 16px 48px}.wrap,#page-body{gap:24px}
.top{flex-direction:column;align-items:flex-start;gap:6px}.top p{font-size:14px;line-height:1.45}
[id]{scroll-margin-top:76px}
.shell{display:block}
.side{position:sticky;top:0;z-index:5;margin:-24px -16px 20px;padding:12px 16px;background:#F9FAFB;border-bottom:1px solid #E5E7EB;overflow-x:auto}
.side-h{display:none}
.side ul{flex-direction:row;flex-wrap:nowrap;gap:8px}
.side a{min-height:44px;padding:0 14px;border:1px solid #D1D5DB;border-radius:999px;background:#FFFFFF;white-space:nowrap}
.chips{flex-wrap:nowrap;overflow-x:auto}.chips button{min-height:44px;white-space:nowrap}
.needs-box{padding:14px 16px}.needs-q{font-size:15px}
.change-log{grid-template-columns:1fr;gap:3px}
.tiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.tile{padding:14px 12px;gap:8px;min-height:0}.tile h3{font-size:13px}.tile-v{font-size:26px}.tile-s{font-size:12px;gap:6px}
.toggle{display:grid;grid-template-columns:1fr 1fr;width:100%}.toggle button{min-height:44px;padding:0 12px}
.awaiting{padding:14px 16px}.awaiting-head h3{font-size:15px}.awaiting-body{height:120px}
.callouts{grid-template-columns:repeat(3,minmax(0,1fr))}.callout{border-bottom:1px solid #E5E7EB}
.levtable:not(.data) thead{display:none}
.levtable:not(.data),.levtable:not(.data) tbody,.levtable:not(.data) tr,.levtable:not(.data) td{display:block;width:auto}
.levtable:not(.data) tr{border-top:1px solid #F0F1F3;padding:10px 0}
.levtable:not(.data) td{border:0;padding:4px 16px}
.levtable:not(.data) td.decide-cell{padding:8px 16px 16px}.levtable:not(.data) tr.needs{padding-bottom:0}.levtable:not(.data) tr.decide-row{border-top:0;padding-top:0}
.choice-cmd{flex-direction:column;align-items:stretch}.copy{min-height:44px;font-size:14px}
.levtable.data .td,.levtable.data .th{padding:10px 12px}
.change summary{grid-template-columns:1fr;gap:3px}
.change-dl{grid-template-columns:1fr;margin-left:0;gap:2px}
.change-dl dd{margin-bottom:8px}
}`;

// The page script: ages the page when it is opened and every minute after, and switches the charts.
const SCRIPT = `(function () {
var ageWords = ${ageWords.toString()};
var pageAge = ${pageAge.toString()};
var bannerHtml = ${bannerHtml.toString()};
var data = JSON.parse(document.getElementById('levers-view').textContent);
var banner = document.getElementById('age-banner');
function tick() {
  var a = pageAge(data.generated_at, Date.now());
  document.getElementById('age-words').textContent = a.words;
  banner.innerHTML = bannerHtml(a, banner.getAttribute('data-since'));
  document.body.setAttribute('data-age', a.state);
}
tick();
setInterval(tick, 60000);
var buttons = document.querySelectorAll('[data-show]');
Array.prototype.forEach.call(buttons, function (b) {
  b.addEventListener('click', function () {
    var want = b.getAttribute('data-show');
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (el) { el.hidden = el.getAttribute('data-view') !== want; });
    Array.prototype.forEach.call(buttons, function (x) { x.setAttribute('aria-pressed', String(x === b)); });
  });
});
// A Copy button puts its command on the clipboard and reads Copied, the others Copy again; where the
// clipboard refuses, the command is selected for the reader to copy.
var copies = document.querySelectorAll('[data-copy]');
Array.prototype.forEach.call(copies, function (b) {
  b.addEventListener('click', function () {
    var copied = function () {
      Array.prototype.forEach.call(copies, function (x) {
        x.textContent = x === b ? 'Copied' : 'Copy';
        x.setAttribute('aria-label', x === b ? 'Copied' : x.getAttribute('data-label'));
      });
    };
    var select = function () {
      var range = document.createRange();
      range.selectNodeContents(b.parentNode.querySelector('code'));
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(b.getAttribute('data-copy')).then(copied, select);
    else select();
  });
});
// The repo filter and the change list's kind filter: an element carrying a repo or a kind other than the
// one picked is hidden; one carrying neither always shows. With a repo picked, a reading across all
// repos (data-all) hides, and so does a row whose repos (data-repos) leave it out; a lever's reading
// in one repo (data-reading) shows only while that repo is picked. The change list says so when
// nothing is left.
var pick = { repo: '', kind: '' };
function apply() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-repo],[data-kind],[data-all],[data-repos]'), function (el) {
    var r = el.getAttribute('data-repo');
    if (el.getAttribute('data-reading') !== null) { el.hidden = r !== pick.repo; return; }
    var k = el.getAttribute('data-kind');
    var rs = el.getAttribute('data-repos');
    var offRepo = r !== null ? r !== pick.repo : el.getAttribute('data-all') !== null || (rs !== null && rs.split(' ').indexOf(pick.repo) < 0);
    el.hidden = !!((pick.repo && offRepo) || (pick.kind && k !== null && k !== pick.kind));
  });
  var none = document.querySelector && document.querySelector('.ch-none');
  if (none) none.hidden = Array.prototype.some.call(document.querySelectorAll('.change,.change-log'), function (el) { return !el.hidden; });
}
[['repo', '[data-pick-repo]', 'data-pick-repo'], ['kind', '[data-pick-kind]', 'data-pick-kind']].forEach(function (f) {
  var group = document.querySelectorAll(f[1]);
  Array.prototype.forEach.call(group, function (b) {
    b.addEventListener('click', function () {
      pick[f[0]] = b.getAttribute(f[2]);
      Array.prototype.forEach.call(group, function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      apply();
    });
  });
});
// A link into a closed section opens it, on load and whenever the address's section changes.
function reveal() {
  var id = decodeURIComponent(window.location.hash.slice(1));
  for (var el = id && document.getElementById(id); el; el = el.parentElement) if (el.tagName === 'DETAILS') el.open = true;
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('hashchange', reveal);
  reveal();
}
})();`;

// view.json as inline JSON that cannot close its script element: `<` and the two JavaScript line
// separators become \u escapes.
const UNSAFE = new RegExp(`[<${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const inlineJson = (v) => JSON.stringify(v).replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// The side menu: a link to each section, with how many levers need you and how many are on. At phone
// width it is a row of buttons along the top that scrolls sideways.
function sideMenu(v) {
  const needs = leverItems(v).length;
  const on = leverRows(v).filter((r) => !['off', 'error'].includes(r.status)).length;
  const link = (id, label, n, tone) => `<li><a href="#${id}">${label}${n ? ` <span class="nav-n nav-${tone} num">${n}</span>` : ''}</a></li>`;
  return `<nav class="side" aria-label="On this page"><p class="muted tiny side-h">On this page</p><ul>`
    + link('ny-h', 'Needs you', needs, 'amber') + link('ov-h', 'Overview') + link('tr-h', 'Trends') + link('lev-h', 'Levers', on, 'blue')
    + link('ch-h', 'Changes') + link('mp-h', 'Merge time and parking') + link('how-h', 'How desk decides') + '</ul></nav>';
}

// The repo filter, once there are two repos to pick between.
function repoChips(v) {
  const names = repoNames(v);
  if (!names.length) return '';
  return `<div role="group" aria-label="Repo" class="chips"><button type="button" data-pick-repo="" aria-pressed="true">All repos</button>${names.map((n) => `<button type="button" data-pick-repo="${esc(n)}" aria-pressed="false">${esc(n)}</button>`).join('')}</div>`;
}

// The whole page for a view model, aged as of `now` (the build's own time unless given); the page
// re-ages itself in the browser when opened.
export function renderPage(view, { now = Date.parse(view.generated_at) } = {}) {
  const tz = view.tz ?? 'UTC';
  const today = !evaluated(view);
  const age = pageAge(view.generated_at, now);
  const okDate = !Number.isNaN(Date.parse(view.generated_at));
  const st = view.panels.status;
  const reporting = !today && view.repos?.length
    ? (st.stale_repos?.length ? ` · ${st.stale_repos.length} of ${view.repos.length} repos not reporting: ${st.stale_repos.join(', ')}` : ` · all ${view.repos.length} repos reporting`)
    : '';
  const sinceText = okDate ? since(view.generated_at, tz) : 'an unknown time';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>Changes</title>
<style>${CSS}</style>
</head>
<body data-age="${age.state}">
<div class="page"><div class="shell">
${sideMenu(view)}
<div class="wrap">
<header class="top"><div class="stack4"><h1>Changes</h1><p class="muted">Everything that changed how desk works, and what happened after.</p></div>
<span class="muted num updated">Updated ${okDate ? esc(clock(view.generated_at, tz)) : DASH} · <span id="age-words">${esc(age.words)}</span>${esc(reporting)}</span></header>
${repoChips(view)}
<div id="age-banner" data-since="${esc(sinceText)}">${bannerHtml(age, esc(sinceText))}</div>
<main id="page-body">
${needsYou(view)}
${overview(view, today)}
${trends(view)}
${leverTable(view, today)}
${asksByArm(view)}
${handoffsByArm(view)}
${changes(view)}
${mergeAndParking(view)}
${howDesk()}
</main>
</div></div></div>
<script type="application/json" id="levers-view">${inlineJson(view)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
