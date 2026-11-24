// The Levers page: one self-contained HTML file rendered from the Levers view model (view.json), that
// opens from file:// with the network off. It words nothing on its own: every figure, label and verdict
// is the view's, and the page only lays them out. view.json is inlined as JSON, since browsers block
// file:// fetches, and a small inline script ages the page at the moment it is opened.
//
//   import { renderPage, pageAge } from './levers-page.mjs'
import * as MS from './merge-stages.mjs';
import { fmtHours } from './stuck-time.mjs';
import { DECISION_RULE, GUARDRAILS, KEPT_STATES as KEPT, REGISTRY } from './lever-registry.mjs';

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
  ledger: 'Records every queue change in a ticket log beside queue.json',
});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : '');
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
const METRICS = Object.freeze({
  cost: { title: 'Cost per Ticket', tile: 'Cost per ticket', sub: () => 'API-equivalent spend per accepted ticket, all repos', scale: 1, v: (x) => `$${x.toFixed(2)}`, pre: '$', post: '' },
  tokens: { title: 'Tokens per Ticket', tile: 'Tokens per ticket', sub: () => 'Input tokens per accepted ticket', scale: 1e-6, v: (x) => `${x.toFixed(1)}M`, pre: '', post: 'M' },
  prompts: { title: 'Permission Prompts per Start', tile: 'Prompts per start', sub: () => 'Times a worker was blocked asking to run a command', scale: 1, v: (x) => x.toFixed(1), pre: '', post: '' },
  fixes: {
    title: 'Fix Tries per Ticket', tile: 'Fix tries per ticket', scale: 1, v: (x) => x.toFixed(2), pre: '', post: '', minStep: 0.01,
    sub: (base) => (fixLimit(base) == null ? 'Fix tries per accepted ticket' : `Must stay under ${fixLimit(base).toFixed(2)} for a lever to be kept`),
  },
});
const scaled = (m, v) => (v == null ? null : v * m.scale);

// Lower is better for every metric: green under the baseline, amber over it, grey with nothing to compare.
// Fix tries are judged against their guardrail limit instead.
function rag(key, metric) {
  const vs = metric.callouts.last_week_vs_before_pct;
  const better = vs != null && vs <= -1;
  if (key === 'fixes') {
    const limit = fixLimit(metric.baseline.value);
    const last = metric.callouts.last_week;
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
    if (every === 1 || (n - 1 - i) % every === 0) o.labels.push({ x: xAt(i), y: y(v) - 6, tf: 'translate(-50%,-100%)', s: m.v(v), c: C.ink });
  });
  if (cur.length) o.segs.push(cur.join(' '));
  const pre = first ? ends.filter((k) => k < first).length : 0;
  if (pre) {
    // A gap too narrow to centre the note in starts it at the gap's left edge instead.
    const wide = pre * dx >= 160;
    o.labels.push({ x: wide ? x0 + (pre * dx) / 2 : x0 + 4, y: (TOP + BOT) / 2, tf: wide ? 'translate(-50%,-50%)' : 'translate(0,-50%)', s: `desk started recording on ${dayLabel(first)}`, c: C.grey, note: true });
  }
}

// The last day of a week starting on `k`, and of the month `m` (YYYY-MM), as day keys.
const weekEnd = (k) => new Date(Date.parse(`${k}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
const monthEnd = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);

function chart(key, metric, view) {
  const m = METRICS[key];
  const base = scaled(m, metric.baseline.value);
  const o = { grid: [], axes: [], ticks: [], labels: [], bases: [], bdots: [], segs: [], dots: [] };
  const first = metric.first_recorded;
  if (view === 'days') {
    panel(o, { labels: metric.daily.map((p) => dayLabel(p.date)), vals: metric.daily.map((p) => scaled(m, p.value)), ends: metric.daily.map((p) => p.date), base, m, x0: W * 0.08, x1: W * 0.95, side: 'left', every: 5, first });
  } else {
    panel(o, { labels: metric.weekly.map((p) => `WK ${isoWeek(p.week)}`), vals: metric.weekly.map((p) => scaled(m, p.value)), ends: metric.weekly.map((p) => weekEnd(p.week)), base, m, x0: W * 0.08, x1: W * 0.48, side: 'left', every: 1, first });
    panel(o, { labels: metric.monthly.map((p) => MONTHS[Number(p.month.slice(5, 7)) - 1]), vals: metric.monthly.map((p) => scaled(m, p.value)), ends: metric.monthly.map((p) => monthEnd(p.month)), base, m, x0: W * 0.54, x1: W * 0.91, side: 'right', every: 2, first });
  }
  const f1 = (v) => v.toFixed(1);
  const aria = `${m.title}: ${view === 'days' ? 'each of the last 30 days' : 'last 6 weeks on the left, last 12 months on the right'}. Black is now${base == null ? '' : `, grey is before levers at ${m.v(base)}`}.`;
  const px = (x) => `${((x / W) * 100).toFixed(3)}%`;
  const py = (y) => `${((y / H) * 100).toFixed(3)}%`;
  return `<div class="chart" data-view="${view}"${view === 'days' ? ' hidden' : ''}>
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
<div class="legend"><span><span class="swatch" style="background:${C.ink}"></span>${esc(m.title)}</span>${base == null ? '' : `<span><span class="swatch" style="background:${C.grey}"></span>Before levers</span>`}</div>
</div>`;
}

const CALLOUTS = [['Yesterday', 'yesterday', false], ['DoD%', 'dod_pct', true], ['Last Wk', 'last_week', false], ['WoW%', 'wow_pct', true], ['vs before', 'last_week_vs_before_pct', true], ['MTD', 'mtd', false], ['MoM%', 'mom_pct', true], ['To date', 'to_date', false], ['vs before', 'to_date_vs_before_pct', true]];
function wbrCard(key, metric) {
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
<p class="muted wbr-sub">${esc(m.sub(metric.baseline.value))}</p>
${chart(key, metric, 'wbr')}
${chart(key, metric, 'days')}
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
  const first = leverItems(v)[0];
  const cta = first ? `<a class="cta" href="#lev-h">Review ${esc(first.lever ?? 'what needs you')}${first.repo ? ` in ${esc(first.repo)}` : ''}</a>` : '';
  return `<section aria-label="Summary" class="card summary"><p><b>${lead}</b> ${body}</p>${cta}</section>${notes(v.panels.status)}`;
}

function spark(metric, m) {
  const vals = metric.weekly.map((p) => scaled(m, p.value));
  const base = scaled(m, metric.baseline.value);
  const all = [...vals.filter((x) => x != null), ...(base == null ? [] : [base])];
  if (!all.length) return '';
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const y = (x) => (hi === lo ? 16 : 28 - ((x - lo) / (hi - lo)) * 24).toFixed(1);
  const pts = vals.map((x, i) => (x == null ? null : `${((i / (vals.length - 1)) * 220).toFixed(0)},${y(x)}`)).filter(Boolean).join(' ');
  return `<svg viewBox="0 0 220 32" width="100%" height="32" aria-hidden="true" class="spark">${base == null ? '' : `<line x1="0" y1="${y(base)}" x2="220" y2="${y(base)}" stroke="${C.grey}" stroke-dasharray="3 3" stroke-width="1"></line>`}<polyline points="${pts}" fill="none" stroke="${C.ink}" stroke-width="2"></polyline></svg>`;
}

const tile = (t) => `<article class="card tile"${t.edge ? ' style="border-color:#FCD34D;background:#FFFBEB"' : ''}><h3 class="muted">${esc(t.label)}</h3><span class="num tile-v">${esc(t.value)}</span><span class="tile-s" style="color:${t.ink ?? '#374151'}"><span class="dot" style="background:${t.dot ?? C.grey}"></span>${esc(t.status)}</span><span class="muted num tile-sub">${esc(t.sub)}</span>${t.spark ?? ''}</article>`;

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
      const r = rag(key, metric);
      const last = metric.callouts.last_week;
      const base = metric.baseline.value;
      const was = base == null ? 'No starting point recorded' : `Was ${m.v(scaled(m, base))}${key === 'fixes' && fixLimit(base) != null ? ` · limit ${fixLimit(base).toFixed(2)}` : ''}`;
      return { label: m.tile, value: last == null ? DASH : m.v(scaled(m, last)), status: r.words, ink: r.ink, dot: r.dot ?? r.c, sub: was, spark: spark(metric, m) };
    };
    const items = leverItems(v);
    const first = items[0];
    list = [metricTile('cost'), metricTile('tokens'), metricTile('fixes'), items.length
      ? { label: 'Needs you', value: String(items.length), status: `${first.lever ?? 'A lever'}${first.repo ? ` in ${first.repo}` : ''}`, ink: C.amberInk, dot: C.amber, sub: first.command ? `Open it with ${first.command}` : (first.text ?? ''), edge: true }
      : { label: 'Needs you', value: '0', status: 'Nothing needs you', sub: 'desk will ask here when a lever needs a decision' }];
  }
  const none = !today && list.slice(0, 3).every((t) => t.value === DASH);
  return `<section aria-label="Headline numbers" class="tiles">${list.map(tile).join('')}</section>${none ? `<p class="muted small">No ticket finished last week, so each number shows ${DASH}.</p>` : ''}`;
}

function trends(v) {
  const p = v.panels.trends;
  const ms = p.metrics ?? {};
  const has = p.state !== 'empty' && Object.values(ms).some((m) => m.first_recorded);
  const toggle = '<div role="group" aria-label="Chart view" class="toggle"><button type="button" data-show="wbr" aria-pressed="true">6 weeks &amp; 12 months</button><button type="button" data-show="days" aria-pressed="false">Last 30 days</button></div>';
  const head = `<div class="sec-head"><div class="stack4"><h2 id="tr-h">Trends</h2><p class="muted small" data-view="wbr">Black is now, grey is before levers. Left: the last 6 weeks. Right: the last 12 months.</p><p class="muted small" data-view="days" hidden>Black is now, grey is before levers. One point a day, so a lever shows within days.</p></div>${toggle}</div>`;
  const body = has
    ? `<div class="cards">${Object.keys(METRICS).filter((k) => ms[k]).map((k) => wbrCard(k, ms[k])).join('')}</div>`
    : `<div class="cards">${Object.values(METRICS).map((m) => `<article class="card awaiting"><div class="awaiting-head"><h3>${esc(m.title)}</h3><span class="rag rag-sm" role="img" aria-label="Grey: no data yet" style="background:${C.grey}"></span></div><div class="awaiting-body"><span class="muted">Awaiting data</span><span class="muted small">This fills in once desk has evaluated its first tickets.</span></div></article>`).join('')}</div>`;
  return `<section aria-labelledby="tr-h" class="stack12">${head}${notes(p)}${body}</section>`;
}

// The outside reviewer's re-reviews per PR and undraft-to-approval time, before and after the learned
// review bar began (review-misses.mjs beforeAfter). Nothing until a check has been learned.
function learned(r) {
  const l = r.learned;
  if (!l) return '';
  const row = (name, s) => `<tr><th scope="row">${name}</th><td>${s.prs}</td><td>${s.rereviews ?? '—'}</td><td>${esc(MS.fmt(s.approval))}</td></tr>`;
  return `<table class="stages"><caption>${esc(r.name)} · learned review bar since ${esc(String(l.since).slice(0, 10))}</caption>`
    + '<thead><tr><th scope="col">Learned bar</th><th scope="col">PRs</th><th scope="col">External re-reviews per PR</th><th scope="col">Undraft to approval (median)</th></tr></thead><tbody>'
    + `${row('Before', l.before)}${row('After', l.after)}</tbody></table>`;
}

// Each repo's merged PR time by stage (merge-stages.mjs): median and p75 per stage, and how many
// external waits inside a reviewer outage were left out. Nothing until a merged PR has its stages.
function mergeStages(v) {
  const repos = v.panels.merge_stages?.repos ?? [];
  if (!repos.length) return '';
  const table = (r) => `<table class="stages"><caption>${esc(r.name)} · ${r.prs} merged PR${r.prs === 1 ? '' : 's'}</caption>`
    + '<thead><tr><th scope="col">Stage</th><th scope="col">Median</th><th scope="col">p75</th><th scope="col">PRs</th></tr></thead><tbody>'
    + MS.STAGES.filter((k) => r.stages?.[k]?.n).map((k) => `<tr><th scope="row">${esc(MS.STAGE_NAMES[k])}</th><td>${esc(MS.fmt(r.stages[k].median))}</td><td>${esc(MS.fmt(r.stages[k].p75))}</td><td>${r.stages[k].n}</td></tr>`).join('')
    + `</tbody></table>${r.outage ? `<p class="muted small">${r.outage} external review wait${r.outage === 1 ? '' : 's'} inside a gate reviewer outage left out of the medians.</p>` : ''}${learned(r)}`;
  return `<section aria-labelledby="ms-h" class="stack12"><div class="sec-head"><h2 id="ms-h">Merge time by stage</h2></div>${repos.map(table).join('')}</section>`;
}

// Each repo's time parked by cause (stuck-time.mjs), this ISO week and last: the hours, the tickets
// affected and each cause, most hours first, with its tracking issue where one is linked. Nothing until a
// ticket has sat stuck.
function stuckTime(v) {
  const repos = v.panels.stuck_time?.repos ?? [];
  if (!repos.length) return '';
  const issue = (l) => (!l ? '—' : l.url ? `<a href="${esc(l.url)}">${esc(l.ref)}</a>` : esc(l.ref));
  const table = (name, w) => `<table class="stages"><caption>${esc(name)} · week ${esc(w.week)} · ${esc(fmtHours(w.hours))} over ${w.tickets} ticket${w.tickets === 1 ? '' : 's'}</caption>`
    + '<thead><tr><th scope="col">Cause</th><th scope="col">Hours</th><th scope="col">Tickets</th><th scope="col">Tracking issue</th></tr></thead><tbody>'
    + w.causes.map((c) => `<tr><th scope="row">${esc(c.cause)}</th><td>${esc(fmtHours(c.hours))}</td><td>${c.tickets}</td><td>${issue(c.link)}</td></tr>`).join('')
    + '</tbody></table>';
  const body = repos.map((r) => r.weeks.filter((w) => w.tickets).map((w) => table(r.name, w)).join('')).join('');
  return `<section aria-labelledby="st-h" class="stack12"><div class="sec-head"><h2 id="st-h">Time parked by cause</h2></div>${body}</section>`;
}

// When desk last kept `lever` in `repo`, from the change list; null when no change records it.
const keptAt = (v, lever, repo) => ((v.panels.changes?.all ?? v.panels.changes?.events ?? [])
  .filter((e) => e.kind === 'transition' && KEPT.includes(e.to) && e.lever === lever && e.repo === repo)
  .map((e) => e.at).sort().pop() ?? null);

// One row per lever: its overall status across repos, and the cell its result is read from.
function leverRows(v) {
  const needs = leverItems(v);
  const anyAuto = (v.repos ?? []).some((r) => r.row === 'auto');
  const order = { kept: 0, testing: 1, needs: 2, pinned: 3, off: 4, error: 5 };
  return (v.panels.board.levers ?? []).map((l, i) => {
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
    else if (reg && !reg.trialled) next = reg.layer === 'quality-risk' ? 'Tested one at a time with blind reviews, once desk starts trialling it.' : 'Not trialled: on only where a repo’s levers row names it.';
    else if (status === 'off' && l.cells.some((c) => c.state === 'ineligible')) next = `${cap(l.cells.filter((c) => c.state === 'ineligible').map((c) => c.note).join('. '))}.`;
    else next = anyAuto ? 'Testing starts with the next tickets desk admits.' : 'Testing starts when a repo is set to auto.';
    const decided = status === 'kept' && main ? keptAt(v, l.lever, main.repo) : null;
    return { lever: l.lever, layer: l.layer, cells: l.cells, status, main, next, decided, i, rank: order[status] };
  }).sort((a, b) => a.rank - b.rank || a.i - b.i);
}

const repoWord = (c) => {
  if (c.state === 'error') return { t: `${c.repo}: ${DASH}, couldn’t read`, c: C.grey };
  if (KEPT.includes(c.state)) return { t: `${c.repo}: kept`, c: C.green };
  if (c.state === 'trial') return { t: `${c.repo}: testing`, c: C.blue };
  if (c.state === 'pinned') return { t: `${c.repo}: on by hand`, c: C.green };
  if (c.state === 'not_enrolled') return { t: `${c.repo}: not enrolled`, c: C.grey };
  if (c.state === 'ineligible') return { t: `${c.repo}: not tested here, as ${c.why}`, c: C.grey };
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
  else if (watching) parts.push(`${watching} guardrail${watching === 1 ? '' : 's'} being watched`);
  else if (gs.length && gs.every((g) => g === 'ok')) parts.push('nothing worse');
  return cap(parts.join(', '));
}

function progress(row, tz) {
  if (row.status === 'kept') return { pct: 100, text: row.decided ? `Decided ${dayMonth(row.decided, tz)}` : 'Decided' };
  if (row.status === 'needs') return { pct: 0, text: 'Paused until you decide' };
  const s = row.main?.sample;
  if (!s) return { pct: 0, text: 'Not started' };
  if (s.n == null) return { pct: 0, text: `Sample not recorded · needs ${s.min}` };
  return { pct: Math.min(100, Math.round((s.n / s.min) * 100)), text: `${s.n} of ${s.min} tickets` };
}

function leverTable(v, today) {
  const p = v.panels.board;
  const rows = leverRows(v);
  const badge = (s) => `<span class="badge" style="${STYLE[s].badge}"><span class="dot" style="background:${STYLE[s].dot}"></span>${STYLE[s].label}</span>`;
  const name = (r, audited) => `<td class="td"><div class="stack3"><span class="b">${esc(r.lever)}</span><span class="muted small">${esc(WHAT[r.lever] ?? '')}</span>${audited && r.layer === 'quality-risk' ? '<span class="tiny" style="color:#4B5563">Each change checked by a blind review after merge</span>' : ''}</div></td>`;
  const stale = p.state === 'stale' && p.age ? `<div role="status" class="note"><span class="dot" style="background:${C.amber};margin-top:6px"></span><span>No new results for ${esc(p.age.words.replace(/ ago$/, ''))}. These are from ${esc(since(p.age.as_of, v.tz))}.</span></div>` : '';
  let head;
  let body;
  let intro;
  if (today) {
    intro = 'No lever is being tested yet, so there are no results. Here’s where each one stands.';
    head = '<tr><th class="th" style="width:34%">Lever</th><th class="th" style="width:18%">Status</th><th class="th">What happens next</th></tr>';
    body = rows.map((r) => `<tr data-lever="${esc(r.lever)}">${name(r, false)}<td class="td">${badge(r.status)}</td><td class="td muted small next">${esc(r.next)}</td></tr>`).join('');
  } else {
    intro = 'One row per lever. Testing means it’s on for half of new tickets, so desk can compare the two halves.';
    head = '<tr><th class="th" style="width:26%">Lever</th><th class="th" style="width:15%">Status</th><th class="th" style="width:20%">Result so far</th><th class="th" style="width:17%">Progress to a decision</th><th class="th">By repo</th></tr>';
    body = rows.map((r) => {
      const res = result(r);
      const pr = progress(r, v.tz);
      return `<tr data-lever="${esc(r.lever)}"${r.status === 'needs' ? ' style="background:#FFFBEB"' : ''}>${name(r, true)}<td class="td">${badge(r.status)}</td>`
        + `<td class="td num"><div class="stack3"><span class="b result" data-verdict="${esc(res.verdict ?? 'none')}" style="color:${res.ink}">${esc(res.text)}</span>${res.notes.map((n) => `<span class="muted tiny">${esc(n)}</span>`).join('')}</div></td>`
        + `<td class="td num"><div class="stack6"><div class="bar" role="img" aria-label="${esc(pr.text)}"><div style="width:${pr.pct}%"></div></div><span class="muted tiny">${esc(pr.text)}</span></div></td>`
        + `<td class="td small"><div class="stack4">${r.cells.map((c) => { const w = repoWord(c); return `<span class="repo"><span class="dot dot-sm" style="background:${w.c}"></span><span>${esc(w.t)}${c.stale ? ' · stale' : ''}</span></span>`; }).join('')}</div></td></tr>`;
    }).join('');
  }
  const legend = today ? '' : `<div class="legend-row muted tiny">${['kept', 'testing', 'needs', 'off'].map((s) => `<span><span class="dot" style="background:${STYLE[s].dot}"></span>${s === 'off' ? 'Off or waiting' : STYLE[s].label}</span>`).join('')}</div>`;
  return `<section aria-labelledby="lev-h" class="card levers"><div class="levers-head"><div class="stack4"><h2 id="lev-h">Is each lever working?</h2><p class="muted small">${intro}</p></div>${legend}${notes(p)}${stale}</div>
<table class="levtable${today ? ' today' : ''}"><thead>${head}</thead><tbody>${body}</tbody></table></section>`;
}

// ---- the change list ---------------------------------------------------------------------------------------------
const you = (e) => e.actor && !['controller', 'supervisor', 'desk'].includes(e.actor);
function changeWhat(e) {
  const lever = e.lever ?? 'a lever';
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
    case 'fp_reset': return `${cap(lever)}’s code changed${where}, so its evidence started again`;
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
  const arms = ev?.n && (ev.n.on != null || ev.n.off != null) ? `${ev.n.on ?? DASH} on, ${ev.n.off ?? DASH} off` : notRecorded;
  const mech = ev?.effect ? `${esc(cap(ev.effect.label))}, ${esc(interval(ev.effect))}${ev.effect.est != null ? `, estimate ${signed(ev.effect.est)}` : ''}` : notRecorded;
  const cost = ev?.cost ? `${esc(cap(ev.cost.label))}, ${esc(interval(ev.cost))}, margin ${signed(ev.cost.margin)}` : notRecorded;
  const guards = ev?.guardrails?.length
    ? `<ul class="guards">${ev.guardrails.map((g) => `<li><span class="b">${esc(String(g.name ?? 'guardrail').replace(/_/g, ' '))}</span>: ${esc(String(g.status).replace(/_/g, ' '))}, ${esc(interval(g))}${g.margin != null ? `, margin ${signed(g.margin)}` : ''}</li>`).join('')}</ul>`
    : notRecorded;
  const row = (k, val) => `<dt>${k}</dt><dd>${val}</dd>`;
  return `<dl class="change-dl">${row('Reason', reason)}${row('Tickets per arm', arms)}${row('Mechanism', mech)}${row('Cost', cost)}${row('Guardrails', guards)}`
    + `${row('Commit range', e.desk_commit_range ? `<span class="mono">${esc(e.desk_commit_range)}</span>` : notRecorded)}`
    + `${row('Evidence file', e.evidence_file ? `<span class="mono">${esc(e.evidence_file)}</span>` : notRecorded)}`
    + `${e.ticket ? row('Ticket', esc(e.ticket)) : ''}</dl>`;
}

function changes(v, today) {
  const p = v.panels.changes;
  const tz = v.tz;
  const every = p.all ?? p.events ?? [];
  const list = today ? p.events ?? [] : every;
  const started = every.filter((e) => e.kind === 'transition' && e.to === 'trial').map((e) => e.at).sort()[0];
  const title = today ? 'What changed this week' : 'Every change desk made';
  const sub = today ? '' : `<p class="muted small sub">${started ? `Newest first, since testing started on ${esc(dayMonth(started, tz))}.` : 'Newest first.'}</p>`;
  let body;
  if (list.length) {
    body = list.map((e) => `<details class="change"><summary><span class="muted num small when">${esc(when(e.at, tz))}</span><span class="stack3"><span class="b">${esc(changeWhat(e))}</span>${e.reason || e.wording ? `<span class="muted small">${esc(cap(e.reason ?? e.wording))}</span>` : ''}</span></summary>${changeDetails(e)}</details>`).join('');
  } else if (today) {
    const last = p.last_change;
    body = `<p class="empty">No lever changed this week.${last ? ` Last change: ${esc(dayMonth(last.at, tz))}, ${esc(lowerFirst(changeWhat(last)))}.` : ''}</p>`;
  } else body = '<p class="empty">desk hasn’t changed anything yet.</p>';
  return `<section aria-labelledby="ch-h" class="card changes"><h2 id="ch-h">${title}</h2>${sub}${notes(p)}${body}</section>`;
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
.summary{padding:18px 20px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}
.summary p{font-size:18px;line-height:1.45;max-width:820px}.summary b{font-weight:600}
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
.bar{height:6px;border-radius:3px;background:#F0F1F3}.bar div{height:6px;border-radius:3px;background:#111827}
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
.empty{padding:12px 0;border-top:1px solid #F0F1F3;font-size:14px}
.how{display:flex;flex-direction:column;gap:6px;padding:0 4px}.how h2{font-size:14px}.how p{max-width:820px;line-height:1.55}
@media (max-width:640px){
.page{padding:24px 16px 48px}.wrap,#page-body{gap:24px}
.top{flex-direction:column;align-items:flex-start;gap:6px}.top p{font-size:14px;line-height:1.45}
.summary{padding:16px}.summary p{font-size:16px;line-height:1.5}
.tiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.tile{padding:14px 12px;gap:8px;min-height:0}.tile h3{font-size:13px}.tile-v{font-size:26px}.tile-s{font-size:12px;gap:6px}
.toggle{display:grid;grid-template-columns:1fr 1fr;width:100%}.toggle button{min-height:44px;padding:0 12px}
.awaiting{padding:14px 16px}.awaiting-head h3{font-size:15px}.awaiting-body{height:120px}
.callouts{grid-template-columns:repeat(3,minmax(0,1fr))}.callout{border-bottom:1px solid #E5E7EB}
.levtable thead{display:none}
.levtable,.levtable tbody,.levtable tr,.levtable td{display:block;width:auto}
.levtable tr{border-top:1px solid #F0F1F3;padding:10px 0}
.levtable td{border:0;padding:4px 16px}
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
})();`;

// view.json as inline JSON that cannot close its script element: `<` and the two JavaScript line
// separators become \u escapes.
const UNSAFE = new RegExp(`[<${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const inlineJson = (v) => JSON.stringify(v).replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

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
<title>Levers</title>
<style>${CSS}</style>
</head>
<body data-age="${age.state}">
<div class="page"><div class="wrap">
<header class="top"><div class="stack4"><h1>Levers</h1><p class="muted">desk tests ways to make tickets cheaper, keeps the ones that work, and turns off the rest.</p></div>
<span class="muted num updated">Updated ${okDate ? esc(clock(view.generated_at, tz)) : DASH} · <span id="age-words">${esc(age.words)}</span>${esc(reporting)}</span></header>
<div id="age-banner" data-since="${esc(sinceText)}">${bannerHtml(age, esc(sinceText))}</div>
<main id="page-body">
${summary(view)}
${tiles(view, today)}
${trends(view)}
${mergeStages(view)}
${stuckTime(view)}
${leverTable(view, today)}
${changes(view, today)}
${today ? '' : howDesk()}
</main>
</div></div>
<script type="application/json" id="levers-view">${inlineJson(view)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
