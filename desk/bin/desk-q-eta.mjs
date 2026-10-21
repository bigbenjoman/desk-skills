#!/usr/bin/env node
// Each repo's spawn-to-merge history, the input to desk-q's ship dates: <state>/eta-history.jsonl,
// one line per merged autopilot ticket, {key, size, spawned_at, merged_at, hours}.
//
// Built once from the queue and the worker logs (`desk-q-eta.mjs build`), then grown by one line per
// merge (`queue.mjs merged <TICKET>`, which the merge driver calls), from the queue alone: a ticket's
// first spawn is `spawned_at` on its queue entry, set by pass.mjs, so a merge never reads a log. Only
// a ticket first spawned before that field existed falls back to its logs.
//
// No model, no Jira: local files, plus one `gh pr list` in a build for tickets that merged before
// the queue recorded `merged_at`. `forecast` turns the history and a queue into desk-q's dates.
import { readFileSync, existsSync, appendFileSync, mkdirSync, readdirSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
// (`<key>.log` and the `<key>.log.round<n>` that requeues moved aside). Null with no stamp anywhere.
export function firstSpawnFromLogs(state, key) {
  const dir = join(state, 'logs');
  if (!existsSync(dir)) return null;
  const mine = readdirSync(dir).filter((f) => f === `${key}.log` || new RegExp(`^${key.replace(/[.]/g, '\\.')}\\.log\\.round\\d+$`).test(f));
  const stamps = mine.map((f) => { try { return firstStamp(join(dir, f)); } catch { return null; } }).filter(Boolean);
  return stamps.length ? stamps.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}

// The size triage recorded, or `unknown`: never guessed from anything else.
export function sizeOf(state, key) {
  try {
    const s = String(JSON.parse(readFileSync(join(state, 'triage', `${key}.json`), 'utf8')).size ?? '').trim().toUpperCase();
    return SIZES.includes(s) ? s : 'unknown';
  } catch { return 'unknown'; }
}

export function historyLine({ key, size, spawned_at, merged_at }) {
  const hours = Math.round(((Date.parse(merged_at) - Date.parse(spawned_at)) / 3_600_000) * 100) / 100;
  return { key, size, spawned_at, merged_at, hours };
}

const append = (state, lines) => {
  if (!lines.length) return;
  mkdirSync(state, { recursive: true });
  appendFileSync(historyPath(state), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
};

// Merge times by PR number, from GitHub, for tickets the queue holds no merged_at for.
export function ghMergedPrs(repo) {
  const out = execFileSync('gh', ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '1000', '--json', 'number,mergedAt'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return Object.fromEntries(JSON.parse(out).map((p) => [p.number, p.mergedAt]));
}

// Add a line for every ticket that merged in the last WINDOW_DAYS and is not in the history yet.
// `mergedPrs` is called at most once, and only when some ticket has a PR but no merged_at.
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
  append(state, lines);
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
  append(state, [line]);
  return { added: [line], already: 0, noSpawn: [] };
}

// ---- the forecast ------------------------------------------------------------------------------
//
// Each repo's queue run forward RUNS times, each ticket's duration drawn from the repo's own history
// by size. Starts and ships are the 50th percentile of a ticket's start and finish across the runs,
// "could run to" the 80th. Seeded, so the same queue, history and clock give the same dates.

export const RUNS = 2000;
export const MIN_HISTORY = 10;
// A size with fewer merged tickets than this draws from the whole history instead.
export const MIN_OF_SIZE = 5;
// The user's check-ins: a ticket waiting on them is dated at the next one when they press c.
export const CHECKIN_HOURS = [8, 17];
const HOUR = 3_600_000, DAY = 86_400_000;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The history lines that merged in the last WINDOW_DAYS before `now`, each with a usable duration.
export function recentHistory(lines, now) {
  const since = now - WINDOW_DAYS * DAY;
  return (lines ?? []).filter((l) => Number.isFinite(l.hours) && l.hours >= 0 && Date.parse(l.merged_at) >= since && Date.parse(l.merged_at) <= now);
}

// Durations in hours, ascending: every line under `all`, and each size's own.
export function durations(lines) {
  const all = lines.map((l) => l.hours).sort((a, b) => a - b);
  const bySize = {};
  for (const l of lines) (bySize[l.size] ??= []).push(l.hours);
  for (const v of Object.values(bySize)) v.sort((a, b) => a - b);
  return { all, bySize };
}

// The durations a ticket of `size` draws from, and whether they are its size's own.
export function durationsFor(d, size) {
  const own = d.bySize[size];
  return own?.length >= MIN_OF_SIZE ? { v: own, own: true } : { v: d.all, own: false };
}

export const quantile = (v, p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];

// Local midnight, so "today" and a weekday are the user's own.
const dayOf = (t) => new Date(t).setHours(0, 0, 0, 0);
const hm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const dayAndTime = (t) => { const d = new Date(t); return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${hm(t)}`; };

// Counted in calendar days: today "today 21:30", the next 6 days "Thu 14:30", 7 days or more "26 Oct",
// with the year only when it is not this year's ("4 Jan 2027").
export function when(t, now) {
  if (t == null) return '—';
  const days = Math.round((dayOf(t) - dayOf(now)) / DAY);
  const d = new Date(t);
  if (days === 0) return `today ${hm(t)}`;
  if (days > 0 && days < 7) return `${DOW[d.getDay()]} ${hm(t)}`;
  return `${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

// The first check-in after `t`.
export function nextCheckin(t) {
  const d = new Date(t);
  for (let i = 0; i < 2; i++) {
    for (const h of CHECKIN_HOURS) {
      const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h).getTime();
      if (c > t) return c;
    }
  }
  return null;
}

// mulberry32: a small seeded generator, so every run of the forecast draws the same numbers.
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// The share of a running ticket's work done, from its stage ("6/9", "4b/9").
const stageDone = (st) => { const m = /^(\d+)(b?)\/9\b/.exec(String(st ?? '')); return m ? Math.min(1, (Number(m[1]) + (m[2] ? 0.5 : 0)) / 9) : 0; };

// `rows` are the queue's unfinished tickets in spawn order, each {key, k, size, stage, held, collides}
// with `k` desk-q's shown state. Returns {none, count} with too little history; otherwise
// {T: {key: {start, likely, late} | null}, clears, undated, count}.
export function forecast({ rows, workers, history, now, checkin = false }) {
  const count = history.length;
  if (count < MIN_HISTORY) return { none: true, count };
  const d = durations(history);
  const inQ = new Set(rows.map((x) => x.key));
  // A collision recorded on either ticket keeps both apart.
  const coll = Object.fromEntries(rows.map((x) => [x.key, new Set()]));
  for (const x of rows) for (const c of x.collides ?? []) if (inQ.has(c) && c !== x.key) { coll[x.key].add(c); coll[c].add(x.key); }
  const avail = (x) => (x.k === 'needs' ? (checkin ? nextCheckin(now) : null) : ['stuck', 'failed'].includes(x.k) ? null : now);
  const pool = Object.fromEntries(rows.map((x) => [x.key, durationsFor(d, x.size).v]));
  const rand = rng(42);
  const draw = (x) => pool[x.key][Math.floor(rand() * pool[x.key].length)] * HOUR;
  const starts = Object.fromEntries(rows.map((x) => [x.key, []]));
  const ends = Object.fromEntries(rows.map((x) => [x.key, []]));
  for (let run = 0; run < RUNS; run++) {
    const f = {}, s = {}, slots = Array(Math.max(1, workers)).fill(now);
    const least = () => slots.indexOf(Math.min(...slots));
    for (const x of rows.filter((y) => y.k === 'running')) {
      const i = least();
      s[x.key] = now;
      f[x.key] = now + draw(x) * (1 - stageDone(x.stage));
      slots[i] = Math.max(slots[i], f[x.key]);
    }
    let pending = workers > 0 ? rows.filter((x) => x.k !== 'running') : [];
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
        for (const c of coll[x.key]) if (f[c] != null && s[c] <= t && f[c] > t) t = f[c];
        // Queue order wins among the tickets that can start as soon as the slot is free.
        if (t <= free) { best = x; bestT = t; break; }
        if (t < bestT) { best = x; bestT = t; }
      }
      if (!best) break;
      const dur = draw(best);
      // Never alongside a ticket it collides with, whichever of the two was placed first.
      for (let moved = true; moved;) {
        moved = false;
        for (const c of coll[best.key]) if (f[c] != null && s[c] < bestT + dur && f[c] > bestT) { bestT = f[c]; moved = true; }
      }
      s[best.key] = bestT;
      f[best.key] = slots[i] = bestT + dur;
      pending = pending.filter((x) => x !== best);
    }
    for (const k of Object.keys(f)) { starts[k].push(s[k]); ends[k].push(f[k]); }
  }
  const T = {};
  for (const x of rows) {
    const v = ends[x.key].sort((a, b) => a - b), st = starts[x.key].sort((a, b) => a - b);
    T[x.key] = v.length >= RUNS * 0.9 ? { start: quantile(st, 0.5), likely: quantile(v, 0.5), late: quantile(v, 0.8) } : null;
  }
  const dated = rows.filter((x) => T[x.key]);
  return { T, count, clears: dated.length ? Math.max(...dated.map((x) => T[x.key].likely)) : null, undated: rows.length - dated.length };
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
