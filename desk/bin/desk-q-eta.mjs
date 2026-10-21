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
// the queue recorded `merged_at`.
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
