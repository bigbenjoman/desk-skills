#!/usr/bin/env node
// Each repo's spawn-to-merge history, the input to desk-q's ship dates: <state>/eta-history.jsonl,
// one line per merged autopilot ticket, {key, size, spawned_at, merged_at, hours}.
//
// Built once from the queue and the worker logs (`desk-q-eta.mjs build`, or pass.mjs when the file is
// missing), then grown by one line per merge (`queue.mjs merged <TICKET>`, which the merge driver calls,
// and pass.mjs for a PR GitHub shows merged however it was merged), from the queue alone: a ticket's
// first spawn is `spawned_at` on its queue entry, set by pass.mjs, so a merge never reads a log. Only
// a ticket first spawned before that field existed falls back to its logs.
//
// No model, no Jira: local files, plus one `gh pr list` in a build for tickets that merged before
// the queue recorded `merged_at`. `forecast` turns the history and a queue into desk-q's dates, and
// <state>/eta.jsonl keeps the first of them per ticket beside its merge time, for the hit rate.
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, readdirSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLogFile } from './harvest.mjs';
import { seededRandom as rng } from './seeded-random.mjs';
import { quantile as interpolated } from './quantile.mjs';

export const HISTORY_FILE = 'eta-history.jsonl';
export const WINDOW_DAYS = 30;
// The ticket size scale, smallest first: triage, planning and the history all read sizes against it.
export const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const SPAWN_STAMP = /"timestamp":"([^"]+)"/;

export const historyPath = (state) => join(state, HISTORY_FILE);

// Every line of the history, first line per key kept: two writers racing on one merge can at worst
// append a key twice, and a reader never counts it twice.
export function readHistory(state) {
  const path = historyPath(state);
  if (!existsSync(path)) return null;
  const seen = new Set();
  const lines = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    let d;
    try { d = JSON.parse(raw); } catch { continue; }
    if (!d?.key || seen.has(d.key)) continue;
    seen.add(d.key);
    lines.push(d);
  }
  return lines;
}

// The first stamp in a log, read a chunk at a time: the first one sits a few seconds after the
// spawn, near the top of a log that can run to megabytes.
function firstStamp(path) {
  if (path.endsWith('.gz')) {
    const m = SPAWN_STAMP.exec(readLogFile(path));
    return m && !Number.isNaN(Date.parse(m[1])) ? m[1] : null;
  }
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let text = '';
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) {
      text += buf.toString('utf8', 0, n);
      const m = SPAWN_STAMP.exec(text);
      if (m && !Number.isNaN(Date.parse(m[1]))) return m[1];
      const nl = text.lastIndexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return null;
  } finally { closeSync(fd); }
}

// The ticket's first worker spawn: the earliest first stamp across every round's log
// (`<key>.log` and the `<key>.log.round<n>[.gz]` that requeues moved aside). Null with no stamp anywhere.
export function firstSpawnFromLogs(state, key) {
  const dir = join(state, 'logs');
  if (!existsSync(dir)) return null;
  const mine = readdirSync(dir).filter((f) => f === `${key}.log` || new RegExp(`^${key.replace(/[.]/g, '\\.')}\\.log\\.round\\d+(\\.gz)?$`).test(f));
  const stamps = mine.map((f) => { try { return firstStamp(join(dir, f)); } catch { return null; } }).filter(Boolean);
  return stamps.length ? stamps.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}

// The size triage recorded, or `unknown`: never guessed from anything else.
export function sizeOf(state, key) {
  try { return sizeIn(JSON.parse(readFileSync(join(state, 'triage', `${key}.json`), 'utf8'))); } catch { return 'unknown'; }
}
// The size triage record `rec` holds, as sizeOf reads it.
export function sizeIn(rec) {
  const s = String(rec?.size ?? '').trim().toUpperCase();
  return SIZES.includes(s) ? s : 'unknown';
}

export function historyLine({ key, size, spawned_at, merged_at }) {
  const hours = Math.round(((Date.parse(merged_at) - Date.parse(spawned_at)) / 3_600_000) * 100) / 100;
  return { key, size, spawned_at, merged_at, hours };
}

const append = (path, lines) => {
  if (!lines.length) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
};

// Merge times by PR number, from GitHub, for tickets the queue holds no merged_at for.
export function ghMergedPrs(repo) {
  const out = execFileSync('gh', ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '1000', '--json', 'number,mergedAt'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return Object.fromEntries(JSON.parse(out).map((p) => [p.number, p.mergedAt]));
}

// Add a line for every ticket that merged in the last WINDOW_DAYS and is not in the history yet.
// `mergedPrs` is called at most once, and only when some ticket has a PR but no merged_at. A build
// whose merge lookup did not fail leaves the file in place even with no lines, so it is built once.
export function buildHistory({ state, queue, mergedPrs = () => ({}), now = Date.now() }) {
  const have = new Set((readHistory(state) ?? []).map((l) => l.key));
  const since = now - WINDOW_DAYS * 86_400_000;
  const report = { added: [], already: 0, noSpawn: [], mergeLookup: null };
  let prs = null;
  const mergedAt = (t) => {
    if (t.merged_at) return t.merged_at;
    if (t.result?.pr == null) return null;
    if (prs === null) { try { prs = mergedPrs() ?? {}; } catch (e) { prs = {}; report.mergeLookup = String(e.message ?? e).split('\n')[0]; } }
    return prs[t.result.pr] ?? null;
  };
  const lines = [];
  for (const [key, t] of Object.entries(queue?.tickets ?? {})) {
    if (have.has(key)) { if (t.merged_at || t.result?.pr != null) report.already += 1; continue; }
    const merged = mergedAt(t);
    if (!merged || Number.isNaN(Date.parse(merged)) || Date.parse(merged) < since) continue;
    const fromLogs = firstSpawnFromLogs(state, key);
    const spawned = [t.spawned_at, fromLogs].filter((s) => s && Date.parse(s) <= Date.parse(merged))
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    if (!spawned) { report.noSpawn.push(key); continue; }
    const line = historyLine({ key, size: sizeOf(state, key), spawned_at: spawned, merged_at: merged });
    lines.push(line);
    report.added.push(line);
    have.add(key);
  }
  append(historyPath(state), lines);
  if (!report.mergeLookup && !existsSync(historyPath(state))) { mkdirSync(state, { recursive: true }); writeFileSync(historyPath(state), ''); }
  return report;
}

// One merge, one line. With no history yet this is the build, which includes this ticket. With one,
// only the queue entry is read, unless it predates `spawned_at`.
export function recordMerge({ state, queue, key, mergedPrs, now = Date.now() }) {
  const hist = readHistory(state);
  if (hist === null) return buildHistory({ state, queue, mergedPrs, now });
  if (hist.some((l) => l.key === key)) return { added: [], already: 1, noSpawn: [] };
  const t = queue.tickets[key];
  const spawned = t.spawned_at ?? firstSpawnFromLogs(state, key);
  if (!spawned || !t.merged_at || Date.parse(spawned) > Date.parse(t.merged_at)) return { added: [], already: 0, noSpawn: [key] };
  const line = historyLine({ key, size: sizeOf(state, key), spawned_at: spawned, merged_at: t.merged_at });
  append(historyPath(state), [line]);
  return { added: [line], already: 0, noSpawn: [] };
}

// ---- saved estimates ---------------------------------------------------------------------------
//
// The first date the forecast gave each ticket, kept so a ship date can be checked against what
// happened: <state>/eta.jsonl gains {key, at, starts, ships, could_run_to} the first time a ticket is
// dated (with the model that made it, and shift_h and stretch, the calibration applied to it, once
// there is one), then
// {key, merged_at} when it merges. Appended only, and the first line of each kind per key
// wins, so a later forecast never overwrites an estimate and two writers racing count once.

export const ESTIMATES_FILE = 'eta.jsonl';
// The hit rate reads the last HIT_LAST merged estimates, and needs MIN_HITS before it gives one.
export const HIT_LAST = 40;
export const MIN_HITS = 10;
// The forecast model an estimate came from: calibration fits only this one's, as one made before the
// outside review was drawn apart ran a day early for reasons this model already corrects.
export const ESTIMATE_MODEL = 2;

export const estimatesPath = (state) => join(state, ESTIMATES_FILE);

// Each key's saved estimate, with its merged_at once it has one: a Map, empty with no file.
export function readEstimates(state) {
  const path = estimatesPath(state);
  const est = new Map(), merges = new Map();
  if (!existsSync(path)) return est;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    let d;
    try { d = JSON.parse(raw); } catch { continue; }
    if (!d?.key) continue;
    if (d.could_run_to != null) {
      if (!est.has(d.key)) est.set(d.key, { key: d.key, at: d.at, starts: d.starts, ships: d.ships, could_run_to: d.could_run_to,
        ...(d.model != null ? { model: d.model } : {}), ...(d.shift_h != null ? { shift_h: d.shift_h } : {}), ...(d.stretch != null ? { stretch: d.stretch } : {}) });
    }
    else if (d.merged_at != null && !merges.has(d.key)) merges.set(d.key, d.merged_at);
  }
  for (const [k, m] of merges) if (est.has(k)) est.get(k).merged_at = m;
  return est;
}

// A line for every ticket the forecast `T` dates that has no saved estimate yet. -> the lines added
export function saveEstimates(state, T, now) {
  const have = readEstimates(state);
  const iso = (t) => new Date(t).toISOString();
  const lines = Object.entries(T ?? {}).filter(([k, e]) => e && !have.has(k))
    .map(([key, e]) => ({ key, at: iso(now), starts: iso(e.start), ships: iso(e.likely), could_run_to: iso(e.late), model: ESTIMATE_MODEL,
      ...(e.stretch != null ? { shift_h: Math.round((e.shift / HOUR) * 100) / 100, stretch: e.stretch } : {}) }));
  append(estimatesPath(state), lines);
  return lines;
}

// The merge time beside a saved estimate, once. -> the estimate with merged_at, or null when the
// ticket has none saved or its merge is already recorded.
export function recordEstimateMerge(state, key, mergedAt) {
  const e = readEstimates(state).get(key);
  if (!e || e.merged_at) return null;
  append(estimatesPath(state), [{ key, merged_at: mergedAt }]);
  return { ...e, merged_at: mergedAt };
}

const okTime = (s) => Number.isFinite(Date.parse(s));
// The saved estimates that have merged, oldest merge first.
const scored = (est) => [...est.values()].filter((e) => okTime(e.merged_at) && okTime(e.could_run_to) && okTime(e.ships))
  .sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at));
const tenth = (h) => Math.round(h * 10) / 10;

// How many of the last HIT_LAST merged estimates merged before their could-run-to time, and how far
// their ships time was from the merge, in hours (merge minus ships, so late is positive):
// {n, hits, pct, signed, abs}, with pct, signed and abs null under MIN_HITS.
export function hitRate(est) {
  const merged = scored(est).slice(-HIT_LAST);
  const hits = merged.filter((e) => Date.parse(e.merged_at) < Date.parse(e.could_run_to)).length;
  const errs = merged.map((e) => (Date.parse(e.merged_at) - Date.parse(e.ships)) / HOUR);
  const few = merged.length < MIN_HITS;
  return { n: merged.length, hits, pct: few ? null : Math.round((hits / merged.length) * 100),
    signed: few ? null : tenth(interpolated(errs, 0.5)), abs: few ? null : tenth(interpolated(errs.map(Math.abs), 0.5)) };
}

// The forecast corrects itself from the last CALIBRATE_LAST merged estimates: ships moves by their
// median error, and the span from ships to could-run-to stretches until RANGE_HOLDS of them merged
// inside it. Only estimates this ESTIMATE_MODEL made count, and each one's own calibration (shift_h,
// stretch) is taken off first, so the fit is always of the uncorrected forecast.
export const CALIBRATE_LAST = 10;
export const RANGE_HOLDS = 0.8;
export const MAX_STRETCH = 10;
// -> {n, shift (ms), stretch, holds (% of the n inside the calibrated range)}, or null with fewer than
// CALIBRATE_LAST of them merged.
export function calibration(est) {
  const last = scored(est).filter((e) => e.model === ESTIMATE_MODEL).slice(-CALIBRATE_LAST);
  if (last.length < CALIBRATE_LAST) return null;
  const raw = last.map((e) => {
    const ships = Date.parse(e.ships) - (Number(e.shift_h) || 0) * HOUR;
    return { merged: Date.parse(e.merged_at), ships, span: Math.max(0, (Date.parse(e.could_run_to) - Date.parse(e.ships)) / (Number(e.stretch) || 1)) };
  });
  const shift = interpolated(raw.map((r) => r.merged - r.ships), 0.5);
  const need = raw.map((r) => { const over = r.merged - (r.ships + shift); return over <= 0 ? 0 : r.span > 0 ? over / r.span : Infinity; }).sort((a, b) => a - b);
  const kth = need[Math.ceil(RANGE_HOLDS * need.length) - 1];
  const stretch = Math.round(Math.min(MAX_STRETCH, Math.max(1, kth)) * 100) / 100;
  const holds = raw.filter((r) => r.merged <= r.ships + shift + stretch * r.span).length;
  return { n: last.length, shift: Math.round(shift), stretch, holds: Math.round((holds / last.length) * 100) };
}

// One date {start, likely, late} under calibration `c`: likely moved by c.shift (an early correction
// never takes away more than half the time left to it), late stretched from it by c.stretch.
export function calibrated(d, c, now) {
  if (!d || !c) return d;
  const likely = Math.max(d.likely + c.shift, (d.likely + Math.max(d.start ?? now, now)) / 2);
  return { ...d, likely, late: likely + c.stretch * (d.late - d.likely), shift: likely - d.likely, stretch: c.stretch };
}

// ---- the forecast ------------------------------------------------------------------------------
//
// Each repo's queue run forward RUNS times. A ticket holds a worker slot from its spawn to its PR's
// undraft, drawn from the repo's own history by size, then waits on the outside review and the merge,
// drawn from its recent merge stages and holding no slot. Each merge weighs half as much every
// HALF_LIFE_DAYS. Starts and ships are the 50th percentile of a ticket's start and finish across the
// runs, "could run to" the 80th, then calibrated from the saved estimates. Seeded, so the same queue,
// history and clock give the same dates.

export const RUNS = 2000;
export const MIN_HISTORY = 10;
// A size with fewer merged tickets than this borrows from its neighbouring sizes.
export const MIN_OF_SIZE = 5;
// Fewer merge-stage records than this, and the spawn-to-merge time is drawn whole.
export const MIN_EXTERNAL = 5;
export const HALF_LIFE_DAYS = 7;
// The user's check-ins: a ticket waiting on them is dated at the next one when they press c.
export const CHECKIN_HOURS = [8, 17];
export const HOUR = 3_600_000, DAY = 86_400_000;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The history lines that merged in the last WINDOW_DAYS before `now`, each with a usable duration.
export function recentHistory(lines, now) {
  const since = now - WINDOW_DAYS * DAY;
  return (lines ?? []).filter((l) => Number.isFinite(l.hours) && l.hours >= 0 && Date.parse(l.merged_at) >= since && Date.parse(l.merged_at) <= now);
}

export const quantile = (v, p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];

// A merge's weight at `now`: halved every HALF_LIFE_DAYS since it merged; 1 with no merge time.
export function weightOf(mergedAt, now) {
  const m = typeof mergedAt === 'number' ? mergedAt : Date.parse(mergedAt ?? '');
  return Number.isFinite(m) ? 0.5 ** (Math.max(0, now - m) / (HALF_LIFE_DAYS * DAY)) : 1;
}

// The weighted p-quantile of [{h, w}] entries, or null with none: quantile's pick when the weights are equal.
export function wquantile(v, p) {
  if (!v?.length) return null;
  const s = [...v].sort((a, b) => a.h - b.h);
  const total = s.reduce((a, e) => a + e.w, 0);
  let acc = 0;
  for (const e of s) { acc += e.w; if (acc > p * total) return e.h; }
  return s.at(-1).h;
}

// A draw from [{h, w}] entries by weight, with `rand` in [0, 1).
function sampler(v, rand) {
  const cum = [];
  let total = 0;
  for (const e of v) cum.push(total += e.w);
  return () => {
    const x = rand() * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] > x) hi = mid; else lo = mid + 1; }
    return v[lo].h;
  };
}

// The history split at each PR's undraft. `stages` are [{key, ready, merged, outage}] (ms) from
// merge-stages; each one inside the window whose wait missed every reviewer outage is an external
// stage, undraft to merge (an outage is counted only by forecast's open-outage extension). With
// MIN_EXTERNAL of them, a line's slot time is spawn to its own undraft, or its spawn to merge less the
// typical external stage where its PR has none read. -> {slot: [{size, h, w}], ext: [{h, w}] | null, all: [{h, w}]}
export function splitHistory(history, stages, now) {
  const since = now - WINDOW_DAYS * DAY;
  const read = (stages ?? []).filter((e) => Number.isFinite(e?.ready) && Number.isFinite(e?.merged) && e.merged >= e.ready && e.merged >= since && e.merged <= now);
  const clear = read.filter((e) => !e.outage);
  const all = history.map((l) => ({ h: l.hours, w: weightOf(l.merged_at, now) }));
  if (clear.length < MIN_EXTERNAL) return { slot: history.map((l, i) => ({ size: l.size, h: l.hours, w: all[i].w })), ext: null, all };
  const ext = clear.map((e) => ({ h: (e.merged - e.ready) / HOUR, w: weightOf(e.merged, now) }));
  const typical = wquantile(ext, 0.5);
  const ready = new Map(read.map((e) => [e.key, e.ready]));
  const slot = history.map((l, i) => {
    const r = ready.get(l.key), sp = Date.parse(l.spawned_at);
    const h = r != null && Number.isFinite(sp) && r >= sp ? (r - sp) / HOUR : Math.max(0, l.hours - typical);
    return { size: l.size, h, w: all[i].w };
  });
  return { slot, ext, all };
}

// How much longer each size up the scale takes: the geometric mean, over every pair of sizes with
// MIN_FOR_RATIO lines each, of their typical times' ratio per step. 1 with no such pair. Fewer than a
// size needs alone are enough here, so one size with a long history and another with a short one give a ratio.
export const MIN_FOR_RATIO = 2;
export function sizeStep(slot) {
  const med = SIZES.map((s) => { const v = slot.filter((l) => l.size === s); return v.length >= MIN_FOR_RATIO ? wquantile(v, 0.5) : null; });
  const logs = [];
  for (let i = 0; i < med.length; i++) for (let j = i + 1; j < med.length; j++) if (med[i] > 0 && med[j] > 0) logs.push(Math.log(med[j] / med[i]) / (j - i));
  return logs.length ? Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length) : 1;
}

// The slot times a ticket of `size` draws from: its size's own with MIN_OF_SIZE of them; else its own
// and its neighbouring sizes', nearest first, each scaled by sizeStep per step, until MIN_OF_SIZE;
// else, or with no size, the whole history. -> {v: [{h, w}], own, n (its size's own count), from: [sizes borrowed],
// scaled (whether a ratio between sizes was read; without one the borrowed times are used as they are)}
export function poolFor(slot, size, step = sizeStep(slot)) {
  const of = (s) => slot.filter((l) => l.size === s);
  const n = of(size).length, idx = SIZES.indexOf(size);
  if (idx >= 0 && n >= MIN_OF_SIZE) return { v: of(size), own: true, n, from: [] };
  if (idx >= 0) {
    const v = [...of(size)], from = [];
    for (let d = 1; d < SIZES.length && v.length < MIN_OF_SIZE; d++) {
      for (const j of [idx - d, idx + d]) {
        const near = j >= 0 && j < SIZES.length ? of(SIZES[j]) : [];
        if (!near.length) continue;
        const k = step ** (idx - j);
        v.push(...near.map((l) => ({ ...l, h: l.h * k })));
        from.push(SIZES[j]);
      }
    }
    if (v.length >= MIN_OF_SIZE) return { v, own: false, n, from, scaled: step !== 1 };
  }
  return { v: slot, own: false, n, from: [] };
}

// Local calendar arithmetic, so "today" and a weekday are the user's own: `days` after the day `t`
// falls on, at `hours` past its midnight; and how many calendar days `t` is after `now`.
export const dayAt = (t, days = 0, hours = 0) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, hours).getTime(); };
export const calendarDays = (t, now) => Math.round((dayAt(t) - dayAt(now)) / DAY);
const hm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const dayAndTime = (t) => { const d = new Date(t); return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${hm(t)}`; };

// Counted in calendar days: today "today 21:30", the next 6 days "Thu 14:30", 7 days or more "26 Oct",
// with the year only when it is not this year's ("4 Jan 2027").
export function when(t, now) {
  if (t == null) return '—';
  const days = calendarDays(t, now);
  const d = new Date(t);
  if (days === 0) return `today ${hm(t)}`;
  if (days > 0 && days < 7) return `${DOW[d.getDay()]} ${hm(t)}`;
  return `${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

// The first check-in after `t`.
export function nextCheckin(t) {
  for (let i = 0; i < 2; i++) {
    for (const h of CHECKIN_HOURS) {
      const c = dayAt(t, i, h);
      if (c > t) return c;
    }
  }
  return null;
}

// The share of a running ticket's work done, from its stage ("6/9", "4b/9").
const stageDone = (st) => { const m = /^(\d+)(b?)\/9\b/.exec(String(st ?? '')); return m ? Math.min(1, (Number(m[1]) + (m[2] ? 0.5 : 0)) / 9) : 0; };

// ---- epics -------------------------------------------------------------------------------------
//
// Triage records each ticket's parent epic (ticket-facts.mjs, from Jira's parent field), and the
// forecast dates an epic as the moment its last child merges, inside each run.

// Whether a Jira issue type is an epic: the epic level of the hierarchy, or a type named for one.
export const isEpic = (type) => type?.hierarchyLevel === 1 || /epic/i.test(String(type?.name ?? ''));

// The triage record's `epic`, from a `desk-jira get --json` issue and its parent's
// `desk-jira children --json` (this repo's children only): {key, summary, children: [{key, done}]}, or
// null when the parent is not an epic. `children` null (the read failed) leaves the list out, so the
// count reads as unknown.
export function epicFact(issue, children) {
  const p = issue?.fields?.parent;
  if (!p?.key || !isEpic(p.fields?.issuetype)) return null;
  const e = { key: p.key, summary: String(p.fields?.summary ?? '') };
  if (Array.isArray(children)) e.children = children.filter((c) => c?.key).map((c) => ({ key: c.key, done: c.fields?.status?.statusCategory?.key === 'done' }));
  return e;
}

// The triage record's `blockers`, from a `desk-jira get --json` issue: its "is blocked by" (Blocks)
// links, [{key, category, summary, type}], with each blocker's status category, summary and type.
export const blockersFact = (issue) => (issue?.fields?.issuelinks ?? [])
  .filter((l) => l.inwardIssue && /blocked by/i.test(l.type?.inward ?? ''))
  .map((l) => ({ key: l.inwardIssue.key, category: l.inwardIssue.fields?.status?.statusCategory?.key ?? 'new',
    summary: l.inwardIssue.fields?.summary ?? null, type: l.inwardIssue.fields?.issuetype?.name ?? null }));

// Whether a blocker record is Done in Jira under a resolution that ships nothing (Won't Do, Duplicate,
// Cannot Reproduce): its code never lands, so a hold waiting for it to land waits for ever. A Done one
// with no resolution read, or none set, is an ordinary Done blocker.
const LANDS = /^(done|fixed)$/i;
export const closedUnlanded = (b) => b?.category === 'done' && typeof b.resolution === 'string' && !!b.resolution.trim() && !LANDS.test(b.resolution.trim());

// A ticket's blockers split from those that are its own epic: its Jira parent epic (`epicKey`) or the
// epic its batch runs (`batchEpic`). An epic is Done only once its children are, so a link to it would
// hold the ticket for ever: it is ignored, and reported. -> {blockers, own: [key]}
export function splitOwnEpic(blockers, epicKey, batchEpic) {
  const mine = new Set([epicKey, batchEpic].filter(Boolean));
  const list = Array.isArray(blockers) ? blockers : [];
  return { blockers: list.filter((b) => !mine.has(b?.key)), own: list.filter((b) => mine.has(b?.key)).map((b) => b.key) };
}

// The epic the batch whose queue file is `path` runs (queue.mjs set-batch epic=<KEY>), or null when
// it runs none or the file cannot be read.
export const queueEpic = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')).epic ?? null; } catch { return null; } };

// Each epic with a child in the queue, from the queue's tickets and their triage records (`triage`,
// key -> record or null). A child is a ticket whose record names the epic, or one an epic's recorded
// children list names. -> {epics: {KEY: {key, summary, total, done, queued, missing, shipped}}, of: {key:
// epic} for the unfinished tickets, noEpic: how many unfinished tickets have none, unread: how many
// unfinished tickets' records are epicUnread, counted apart from noEpic}. With `jira` false (the
// repo's Tracker is not jira) no pass reads them, so they count as having none. `missing` is how
// many children are not in the queue and not done, null when no record holds the epic's children;
// `shipped` is the last merge among its done children in the queue.
// A triage record written before ticket-facts.mjs recorded `epic`, and not read since: no `epic` key
// (null means looked up, none), and not a non-tracker key's `links: 'n/a'`. pass.mjs reads these.
export const epicUnread = (rec) => rec != null && !('epic' in rec) && rec.links !== 'n/a';

export function epicsOf(tickets, triage, { jira = true } = {}) {
  const epics = {}, kidsOf = {}, listed = {};
  const epicOf = (k) => triage[k]?.epic?.key ?? null;
  for (const k of Object.keys(tickets)) {
    const e = triage[k]?.epic;
    if (!e?.key) continue;
    epics[e.key] ??= { key: e.key, summary: e.summary ?? '' };
    if (!epics[e.key].summary && e.summary) epics[e.key].summary = e.summary;
    (kidsOf[e.key] ??= new Set()).add(k);
    if (Array.isArray(e.children)) for (const c of e.children) (listed[e.key] ??= new Map()).set(c.key, (listed[e.key].get(c.key) ?? false) || c.done);
  }
  const of = {};
  for (const [k, t] of Object.entries(tickets)) {
    if (t.state === 'done') continue;
    const ep = epicOf(k) ?? Object.keys(listed).find((e) => listed[e].has(k)) ?? null;
    if (ep) { of[k] = ep; kidsOf[ep].add(k); }
  }
  for (const [ep, e] of Object.entries(epics)) {
    const keys = new Set([...kidsOf[ep], ...(listed[ep]?.keys() ?? [])]);
    let done = 0, queued = 0, missing = 0, shipped = null;
    const kids = {};
    for (const k of keys) {
      const t = tickets[k];
      if (t && t.state !== 'done') { queued++; kids[k] = 'queued'; }
      else if (t?.state === 'done' || listed[ep]?.get(k)) {
        done++;
        kids[k] = 'done';
        if (Number.isFinite(Date.parse(t?.merged_at))) shipped = Math.max(shipped ?? -Infinity, Date.parse(t.merged_at));
      } else { missing++; kids[k] = 'missing'; }
    }
    Object.assign(e, { total: keys.size, done, queued, missing: listed[ep] ? missing : null, shipped, kids });
  }
  const unfinished = Object.entries(tickets).filter(([, t]) => t.state !== 'done').map(([k]) => k);
  const isUnread = (k) => jira && !of[k] && epicUnread(triage[k]);
  return { epics, of, noEpic: unfinished.filter((k) => !of[k] && !isUnread(k)).length, unread: unfinished.filter(isUnread).length };
}

// `rows` are the queue's unfinished tickets in spawn order, each {key, k, size, stage, held, collides,
// epic} with `k` desk-q's shown state. `epics` is {KEY: {missing}}: children not queued yet join the end
// of the queue, each with a duration drawn from the whole history, shared across the workers.
// `stages`: splitHistory's. `outageFrom`: when the outside reviewer's open outage began (ms), or null;
// no outside review starts until it has lasted as long again. `calib`: calibration's, or null.
// Returns {none, count} with too little history; otherwise {T: {key: {start, likely, late} | null},
// E: {epic: {start, likely, late, setBy} | null}, clears, undated, count, P: {size: poolFor}, ext, calib}.
export function forecast({ rows, workers, history, now, checkin = false, epics = {}, stages = [], outageFrom = null, calib = null }) {
  const count = history.length;
  if (count < MIN_HISTORY) return { none: true, count };
  const { slot, ext, all } = splitHistory(history, stages, now);
  const step = sizeStep(slot);
  const P = Object.fromEntries([...new Set(rows.map((x) => x.size))].map((s) => [s, poolFor(slot, s, step)]));
  const inQ = new Set(rows.map((x) => x.key));
  // A collision recorded on either ticket keeps both apart.
  const coll = Object.fromEntries(rows.map((x) => [x.key, new Set()]));
  for (const x of rows) for (const c of x.collides ?? []) if (inQ.has(c) && c !== x.key) { coll[x.key].add(c); coll[c].add(x.key); }
  const avail = (x) => (x.k === 'needs' ? (checkin ? nextCheckin(now) : null) : ['stuck', 'failed'].includes(x.k) ? null : now);
  const rand = rng(42);
  const draws = Object.fromEntries(Object.entries(P).map(([s, p]) => [s, sampler(p.v, rand)]));
  const draw = (x) => draws[x.size]() * HOUR;
  const extDraw = ext ? sampler(ext, rand) : () => 0;
  const reviewFrom = Number.isFinite(outageFrom) ? now + Math.max(0, now - outageFrom) : -Infinity;
  // The ticket's merge, once its slot time ends at `freed`.
  const merged = (freed, e) => Math.max(freed, reviewFrom) + e;
  const starts = Object.fromEntries(rows.map((x) => [x.key, []]));
  const ends = Object.fromEntries(rows.map((x) => [x.key, []]));
  // The epics' own draws come from their own generator, so a ticket's dates are the same with or without them.
  const erand = rng(7);
  const allDraw = sampler(all, erand);
  const kids = Object.fromEntries(Object.keys(epics).map((ep) => [ep, rows.filter((x) => x.epic === ep).map((x) => x.key)]));
  const epicEnds = Object.fromEntries(Object.keys(epics).map((ep) => [ep, []]));
  for (let run = 0; run < RUNS; run++) {
    // f: each ticket's merge; u: when its worker is done (its undraft), which ends a collision.
    const f = {}, u = {}, s = {}, slots = Array(Math.max(1, workers)).fill(now);
    const least = () => slots.indexOf(Math.min(...slots));
    for (const x of rows.filter((y) => y.k === 'running')) {
      const i = least();
      s[x.key] = now;
      u[x.key] = now + draw(x) * (1 - stageDone(x.stage));
      f[x.key] = merged(u[x.key], extDraw() * HOUR);
      slots[i] = Math.max(slots[i], u[x.key]);
    }
    // A finished worker (`finishing`) holds no slot: it is dated where its stage left it.
    for (const x of rows.filter((y) => y.k === 'finishing')) {
      s[x.key] = now;
      u[x.key] = now + draw(x) * (1 - stageDone(x.stage));
      f[x.key] = merged(u[x.key], extDraw() * HOUR);
    }
    let pending = workers > 0 ? rows.filter((x) => !['running', 'finishing'].includes(x.k)) : [];
    while (pending.length) {
      const i = least(), free = slots[i];
      let best = null, bestT = Infinity;
      for (const x of pending) {
        const a = avail(x);
        if (a == null) continue;
        let t = Math.max(a, free), ok = true;
        for (const b of x.held ?? []) {
          if (!inQ.has(b)) continue;
          if (f[b] == null) { ok = false; break; }
          t = Math.max(t, f[b]);
        }
        if (!ok) continue;
        for (const c of coll[x.key]) if (u[c] != null && s[c] <= t && u[c] > t) t = u[c];
        // Queue order wins among the tickets that can start as soon as the slot is free.
        if (t <= free) { best = x; bestT = t; break; }
        if (t < bestT) { best = x; bestT = t; }
      }
      if (!best) break;
      const held = draw(best), e = extDraw() * HOUR;
      // Never alongside a ticket it collides with, whichever of the two was placed first.
      for (let moved = true; moved;) {
        moved = false;
        for (const c of coll[best.key]) if (u[c] != null && s[c] < bestT + held && u[c] > bestT) { bestT = u[c]; moved = true; }
      }
      s[best.key] = bestT;
      u[best.key] = slots[i] = bestT + held;
      f[best.key] = merged(u[best.key], e);
      pending = pending.filter((x) => x !== best);
    }
    let end = now;
    for (const k of Object.keys(f)) { starts[k].push(s[k]); ends[k].push(f[k]); end = Math.max(end, f[k]); }
    // In each run the epic ships when its last child merges; one child left undated leaves the run out.
    for (const [ep, ks] of Object.entries(kids)) {
      if (ks.some((k) => f[k] == null)) continue;
      let m = ks.length ? Math.max(...ks.map((k) => f[k])) : end;
      const missing = epics[ep].missing ?? 0;
      // With no workers, a child not queued yet never starts.
      if (missing && workers <= 0) continue;
      if (missing) {
        let extra = 0;
        for (let j = 0; j < missing; j++) extra += allDraw() * HOUR;
        m = Math.max(m, end + extra / Math.max(1, workers));
      }
      epicEnds[ep].push(m);
    }
  }
  const T = {};
  for (const x of rows) {
    const v = ends[x.key].sort((a, b) => a - b), st = starts[x.key].sort((a, b) => a - b);
    T[x.key] = v.length >= RUNS * 0.9 ? calibrated({ start: quantile(st, 0.5), likely: quantile(v, 0.5), late: quantile(v, 0.8) }, calib, now) : null;
  }
  // An epic starts when its first child starts, and is set by the child that ships last.
  const E = {};
  for (const [ep, ks] of Object.entries(kids)) {
    const v = epicEnds[ep].sort((a, b) => a - b);
    if (!(v.length >= RUNS * 0.9 && ks.every((k) => T[k]))) { E[ep] = null; continue; }
    const start = ks.length ? Math.min(...ks.map((k) => T[k].start)) : null;
    const { shift, stretch, ...d } = calibrated({ start, likely: quantile(v, 0.5), late: quantile(v, 0.8) }, calib, now);
    E[ep] = { ...d, setBy: ks.length ? ks.reduce((a, k) => (T[k].likely > T[a].likely ? k : a)) : null };
  }
  const dated = rows.filter((x) => T[x.key]);
  return { T, E, count, clears: dated.length ? Math.max(...dated.map((x) => T[x.key].likely)) : null, undated: rows.length - dated.length, P, ext, calib };
}

export function describe(r) {
  const bySize = {};
  for (const l of r.added) bySize[l.size] = (bySize[l.size] ?? 0) + 1;
  const sizes = [...SIZES, 'unknown'].filter((s) => bySize[s]).map((s) => `${s} ${bySize[s]}`).join(', ');
  const out = [`eta history: ${r.added.length} line(s) added${sizes ? ` (${sizes})` : ''}${r.already ? `, ${r.already} already recorded` : ''}`];
  if (r.noSpawn.length) out.push(`left out ${r.noSpawn.length} merged ticket(s) with no spawn record: ${r.noSpawn.join(', ')}`);
  if (r.mergeLookup) out.push(`could not read merge times from GitHub (${r.mergeLookup}): tickets with no merged_at were skipped`);
  return out.join('\n');
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const { stateDir, queueFile, ghRepo } = await import('./desk-env.mjs');
  const { readQueue } = await import('./batch-state.mjs');
  const [cmd] = process.argv.slice(2);
  if (cmd !== 'build') { console.error('usage: desk-q-eta.mjs build   (adds every merged ticket not yet in <state>/eta-history.jsonl)'); process.exit(2); }
  try {
    const queue = existsSync(queueFile()) ? readQueue(queueFile()) : { tickets: {} };
    console.log(describe(buildHistory({ state: stateDir(), queue, mergedPrs: () => ghMergedPrs(ghRepo()) })));
  } catch (e) { console.error(`desk-q-eta: ${e.message ?? e}`); process.exit(11); }
}
