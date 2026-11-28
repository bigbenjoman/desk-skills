// The Levers view cut into one small file per page, so the static pages and the Desk app read only
// what a page shows: overview.json, levers.json, lever-<name>.json for each lever and trends.json,
// written under view/ beside view.json. Each carries the view's `v`, `generated_at`, `tz` and the age
// of every input, and words nothing the view does not: it only selects, trims and groups.
//
//   import { writeSlices, inputsOf } from './levers-slices.mjs'
//
// Chart markers: the 30-day charts mark lever changes and every change-log entry (Claude Code
// updates, worker-facing PRs, settings), the 6-week and 12-month charts lever changes only; changes on
// one point (a day, a week, a month) are one marker with a count, and a chart keeps the newest
// MAX_MARKERS. A figure desk does not have is null with a reason (`reasons`), never 0.
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { localDay } from './desk-env.mjs';
import { monthOf, weekStart } from './day-keys.mjs';
import { DECISION_RULE, KEPT_STATES as KEPT, OFF_STATES, REGISTRY, TESTING_STATES, isValued } from './lever-registry.mjs';
import { writeTextAtomic } from './dir-lock.mjs';

const SLICES_DIR = 'view';
const MAX_MARKERS = 5;
// The change kinds a chart marks as "a lever changed": a lever's state or share moving.
const LEVER_KINDS = Object.freeze(['transition', 'trip', 'override', 'freeze', 'thaw', 'pair', 'ramp']);
const LAST_CHANGES = 5;

// `o` with a `reasons` entry, `why`, for each of `keys` that is null: a figure desk does not have.
function withReasons(o, keys, why) {
  const missing = keys.filter((k) => o[k] == null);
  return missing.length ? { ...o, reasons: { ...o.reasons, ...Object.fromEntries(missing.map((k) => [k, why])) } } : o;
}

// The age of every input, as build.json records it.
export function inputsOf(view) {
  return {
    supervisor: view.repos.map((r) => ({ repo: r.name, ...r.supervisor })), health: view.panels.status.health,
    evaluation: view.panels.board.age, pooled: view.panels.board.pooled_age, post_merge: view.panels.guardrails.post_merge,
  };
}

const head = (view, page) => ({ v: view.v, page, generated_at: view.generated_at, tz: view.tz, inputs: inputsOf(view) });
const panelHead = (p) => ({ state: p.state, ...(p.errors ? { errors: p.errors } : {}) });

// ---- markers ---------------------------------------------------------------------------------------
const dayKey = (iso, tz) => localDay(Date.parse(iso), tz);
// Each range's point key, from the same helpers levers-view.mjs keys the points by.
const RANGES = Object.freeze({
  daily: { key: 'date', of: (k) => k },
  weekly: { key: 'week', of: weekStart },
  monthly: { key: 'month', of: monthOf },
});

const pick = (o, keys) => (o == null ? null : Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])));
// What a marker says of one change: a lever's, from the view's change list, or a change-log entry (a
// Claude Code update, a worker-facing PR, a settings change).
const leverItem = (e) => ({ at: e.at, kind: e.kind, lever: e.lever, ...(e.levers ? { levers: e.levers } : {}), repo: e.repo, from: e.from, to: e.to, wording: e.wording ?? null });
const logItem = (e) => pick(e, ['at', 'kind', 'repo', 'from', 'to', 'pr', 'ticket', 'title', 'row']);

// The changes a chart's points cover, one marker per point holding any, newest MAX_MARKERS kept, oldest
// first: [{ <date|week|month>, count, at, kinds, items }] with `items` newest first, at most
// MAX_MARKERS of them. `keys` are the chart's points' keys. -> { markers, left_out }
function markersOf(changes, keys, range, tz) {
  const { key, of } = RANGES[range];
  const inside = new Set(keys);
  const groups = new Map();
  for (const c of changes) {
    if (Number.isNaN(Date.parse(c.at))) continue;
    const k = of(dayKey(c.at, tz));
    if (!inside.has(k)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const all = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, cs]) => {
    const items = [...cs].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { [key]: k, count: items.length, at: items[0].at, kinds: [...new Set(items.map((i) => i.kind))].sort(), items: items.slice(0, MAX_MARKERS) };
  });
  return { markers: all.slice(-MAX_MARKERS), left_out: Math.max(0, all.length - MAX_MARKERS) };
}

// Each range's markers for charts drawn from `metric`'s points: the 30 days mark lever changes and
// every change-log entry, the weeks and months lever changes only.
function chartMarkers(view, metric) {
  const lever = (view.panels.changes.all ?? []).filter((e) => LEVER_KINDS.includes(e.kind)).map(leverItem);
  const log = (view.panels.change_log.entries ?? []).map(logItem);
  const out = { markers: {}, markers_left_out: {} };
  for (const [range, changes] of [['daily', [...lever, ...log]], ['weekly', lever], ['monthly', lever]]) {
    const { markers, left_out } = markersOf(changes, metric[range].map((p) => p[RANGES[range].key]), range, view.tz);
    out.markers[range] = markers;
    out.markers_left_out[range] = left_out;
  }
  return out;
}

const chartOf = (view, metric) => ({ ...metric, ...chartMarkers(view, metric) });
// A metric without its points, for a tile.
const tileOf = ({ daily: _d, weekly: _w, monthly: _m, ...rest }) => rest;

// ---- the overview's verdict --------------------------------------------------------------------------
// The levers each state holds, by name, over every repo's cells.
const leversIn = (cells, pred) => [...new Set(cells.filter(pred).map((c) => c.lever))].sort();

// Every metric over its limit, judged on the figure since desk started recording and then on last week,
// and every breached guardrail: what the verdict must not leave out.
function problemsOf(view) {
  const out = [];
  for (const [metric, m] of Object.entries(view.panels.trends.metrics ?? {})) {
    const limit = m.limit?.value;
    if (limit == null) continue;
    const over = ['to_date', 'last_week'].find((k) => m.callouts[k] != null && m.callouts[k] > limit);
    if (over) out.push({ kind: 'metric', metric, title: m.title, value: m.callouts[over], over, limit, baseline: m.baseline.value, counts: m.counts[over] });
  }
  for (const g of view.panels.guardrails.rows ?? []) {
    if (g.status === 'breached') out.push({ kind: 'guardrail', lever: g.lever, repo: g.repo, name: g.name, est: g.est ?? null, margin: g.margin ?? null });
  }
  return out;
}

// What the overview leads with: the lever nearest a decision (the largest share of its minimum in the
// smaller arm), how many levers are being tested, kept, turned off by desk and on by hand, and every
// problem, the first as `problem`. A repo not enrolled is left out, as the levers slice leaves it out.
export function verdictOf(view) {
  const cells = enrolledCells(view, (view.panels.board.levers ?? []).flatMap((l) => l.cells.map((c) => ({ ...c, lever: l.lever }))));
  const testingCell = (c) => TESTING_STATES.includes(c.state);
  const lead = cells.filter((c) => testingCell(c) && c.sample?.n != null && c.sample.min)
    .sort((a, b) => b.sample.n / b.sample.min - a.sample.n / a.sample.min || b.sample.n - a.sample.n || (a.lever < b.lever ? -1 : 1))[0] ?? null;
  const problems = problemsOf(view);
  const testing = leversIn(cells, testingCell);
  const reverted = leversIn(cells, (c) => OFF_STATES.includes(c.state));
  return {
    state: view.line.state,
    lead: lead ? { lever: lead.lever, repo: lead.repo, n: lead.sample.n, min: lead.sample.min, on: lead.sample.on, off: lead.sample.off, ready: lead.sample.n >= lead.sample.min, next: lead.next ?? null } : null,
    testing: testing.length, kept: leversIn(cells, (c) => KEPT.includes(c.state)).length,
    reverted: reverted.length, reverted_levers: reverted, pinned: (view.panels.status.pinned ?? []).length,
    needs_you: (view.panels.waiting.items ?? []).filter((i) => i.kind === 'lever').length,
    problem: problems[0] ?? null, problems,
  };
}

// ---- the change log, for the overview's last five -------------------------------------------------------
const NO_COST = 'no merged ticket with its cost recorded';
const NO_AUDIT = 'no PR of these tickets audited';
const side = (s) => (s == null ? null : withReasons(withReasons(s, ['median_usd'], NO_COST), ['p0', 'p1', 'p2'], NO_AUDIT));
const changeEntry = ({ before, after, paths, ...e }) => ({ ...e, files: paths?.length ?? null, before: side(before), after: side(after) });

// ---- repos not enrolled ------------------------------------------------------------------------------
const NOT_ENROLLED = Object.freeze(['missing', 'none']);
const notEnrolled = (view) => view.repos.filter((r) => NOT_ENROLLED.includes(r.row)).map((r) => ({ repo: r.name, row: r.row, reads: r.reads }));
const enrolledCells = (view, cells) => {
  const out = new Set(notEnrolled(view).map((r) => r.repo));
  return cells.filter((c) => !out.has(c.repo));
};

// A lever cell as the levers table shows it: its state, on and off counts and minimum, and the result
// so far in words. A count the evaluation did not record is null with a reason.
const NOT_COUNTED = 'not recorded by the latest evaluation';
const COUNTS = ['on', 'off', 'n', 'min'];
function tableCell(c) {
  const cell = {
    ...pick(c, ['repo', 'state', 'status', 'why', 'note', 'stale', 'turned_off_at', 'as_of', 'decision', 'reason', 'next', 'guardrail_chip']),
    ...(c.sample ? pick(c.sample, COUNTS) : {}),
    ...(c.effect ? { effect: pick(c.effect, ['metric', 'unit', 'est', 'lo90', 'hi90', 'verdict', 'label']) } : {}),
    ...(c.cost ? { cost: pick(c.cost, ['ratio', 'lo90', 'hi90', 'margin', 'verdict', 'label', 'saving_usd']) } : {}),
    ...(c.error ? { error: c.error } : {}),
  };
  return c.sample ? withReasons(cell, COUNTS, NOT_COUNTED) : cell;
}

// ---- the slices --------------------------------------------------------------------------------------
export function overviewSlice(view) {
  const { trends, change_log: log } = view.panels;
  const metrics = trends.metrics ?? {};
  return {
    ...head(view, 'overview'),
    status: view.panels.status, line: view.line, verdict: verdictOf(view), cost: view.panels.cost,
    trends: { ...panelHead(trends), first_recorded: trends.first_recorded ?? null },
    tiles: Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, tileOf(m)])),
    chart: metrics.cost ? { metric: 'cost', ...chartOf(view, metrics.cost) } : null,
    change_log: { ...panelHead(log), total: (log.entries ?? []).length, entries: [...(log.entries ?? [])].reverse().slice(0, LAST_CHANGES).map(changeEntry) },
    waiting: view.panels.waiting,
  };
}

export function leversSlice(view) {
  const board = view.panels.board;
  return {
    ...head(view, 'levers'),
    status: view.panels.status, board: { ...panelHead(board), age: board.age, pooled_age: board.pooled_age },
    not_enrolled: notEnrolled(view),
    levers: (board.levers ?? []).map((l) => ({ lever: l.lever, layer: l.layer, min: DECISION_RULE.min_per_arm[l.layer] ?? null, cells: enrolledCells(view, l.cells).map(tableCell) })),
  };
}

export function leverSlice(view, lever) {
  const board = view.panels.board;
  const l = (board.levers ?? []).find((x) => x.lever === lever);
  const reg = REGISTRY[lever];
  const cells = enrolledCells(view, l?.cells ?? []);
  const mine = (e) => e.lever === lever || (e.levers ?? []).includes(lever);
  return {
    ...head(view, 'lever'),
    lever, layer: reg?.layer ?? l?.layer ?? null, min: DECISION_RULE.min_per_arm[reg?.layer] ?? null, baseline: reg && isValued(reg) ? reg.baseline : null,
    board: { ...panelHead(board), age: board.age, pooled_age: board.pooled_age },
    not_enrolled: notEnrolled(view), cells,
    evidence: cells.filter((c) => c.sample).map((c) => withReasons({ repo: c.repo, on: c.sample.on, off: c.sample.off, pooled_on: c.sample.pooled_on, pooled_off: c.sample.pooled_off, min: c.sample.min }, ['on', 'off', 'pooled_on', 'pooled_off', 'min'], NOT_COUNTED)),
    guardrails: (view.panels.guardrails.rows ?? []).filter((g) => g.lever === lever),
    changes: (view.panels.changes.all ?? []).filter(mine),
    waiting: (view.panels.waiting.items ?? []).filter((i) => i.kind === 'lever' && i.lever === lever),
  };
}

export function trendsSlice(view) {
  const trends = view.panels.trends;
  return {
    ...head(view, 'trends'), ...panelHead(trends), first_recorded: trends.first_recorded ?? null,
    metrics: Object.fromEntries(Object.entries(trends.metrics ?? {}).map(([k, m]) => [k, chartOf(view, m)])),
  };
}

// Every slice of `view`, by file name.
function slicesOf(view) {
  const levers = (view.panels.board.levers ?? []).map((l) => l.lever);
  return {
    'overview.json': overviewSlice(view), 'levers.json': leversSlice(view), 'trends.json': trendsSlice(view),
    ...Object.fromEntries(levers.map((name) => [`lever-${name}.json`, leverSlice(view, name)])),
  };
}

// Writes every slice of `view` under `<dir>/view/`, and removes a lever-<name>.json for a lever the
// view no longer has. -> { dir, files }
export function writeSlices(dir, view) {
  const out = join(dir, SLICES_DIR);
  const slices = slicesOf(view);
  // Unindented: they are read by programs, and the size is the point.
  for (const [name, body] of Object.entries(slices)) writeTextAtomic(join(out, name), `${JSON.stringify(body)}\n`);
  let had = [];
  try { had = readdirSync(out); } catch { had = []; }
  for (const f of had) if (/^lever-.+\.json$/.test(f) && !Object.hasOwn(slices, f)) rmSync(join(out, f), { force: true });
  return { dir: out, files: Object.keys(slices).map((n) => join(out, n)) };
}
