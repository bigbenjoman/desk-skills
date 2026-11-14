// Prompt-cache use per caller, from the session transcripts of every Claude login (claude-logins.mjs):
// how many tokens each kind of desk call sent uncached, wrote to the 1-hour and the 5-minute cache, and
// read back, and what that would cost at API list prices (worker-cost.mjs MODEL_PRICES). One window
// gives one row per caller; a before and an after window put each caller's two side by side, per
// request and per session, to show whether a change of cache TTL saved anything.
//
// A request is one assistant line's usage, counted once by requestId however many lines repeat it. A
// transcript is one session, attributed by how it started: its first prompt names the usage probe,
// the decider or a triage pass; an interactive session is entrypoint `cli`; any other headless one in
// a `*-worktrees/` folder is a worker; anything else is `other`. Sidechain requests are `subagent`,
// whoever called them.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectsDirs } from './claude-logins.mjs';
import { DECIDER_OPENING } from './decider.mjs';
import { PROBE_ARGS } from './usage-probe.mjs';
import { MODEL_PRICES, modelFamily } from './worker-cost.mjs';

export const CALLERS = ['worker', 'triage', 'decider', 'usage probe', 'subagent', 'interactive', 'other'];
const PROBE_PROMPT = PROBE_ARGS[PROBE_ARGS.indexOf('-p') + 1];
// How triage.sh's first pass and its challenge pass start their prompts.
const TRIAGE_OPENINGS = ['Triage ticket ', 'A first triage pass put ticket '];

// The caller of a session from its first prompt, working folder and entrypoint.
export function callerOf({ prompt = '', cwd = '', entrypoint = null }) {
  if (prompt.trim() === PROBE_PROMPT) return 'usage probe';
  if (prompt.startsWith(DECIDER_OPENING)) return 'decider';
  if (TRIAGE_OPENINGS.some((o) => prompt.startsWith(o))) return 'triage';
  if (entrypoint === 'cli') return 'interactive';
  if (entrypoint && /-worktrees\//.test(`${cwd}/`)) return 'worker';
  return 'other';
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '');

// One assistant line's request, or null for a line that is not one. Cache writes go by the split the
// usage reports; without one they go under the TTL the line asked for, the 1-hour one where it names none.
export function requestOf(d) {
  const u = d?.type === 'assistant' ? d.message?.usage : null;
  if (!u || d.message?.model === '<synthetic>') return null;
  const n = (v) => Number(v) || 0;
  const asked = ['5m', '1h'].includes(d.promptCacheRequested) ? d.promptCacheRequested : null;
  const split = u.cache_creation;
  const write = n(u.cache_creation_input_tokens);
  const w5m = split ? n(split.ephemeral_5m_input_tokens) : asked === '5m' ? write : 0;
  const w1h = split ? n(split.ephemeral_1h_input_tokens) : asked === '5m' ? 0 : write;
  const ttls = new Set([asked, w5m ? '5m' : null, w1h ? '1h' : null].filter(Boolean));
  return {
    id: d.requestId ?? d.message?.id ?? null, at: Date.parse(d.timestamp), sidechain: !!d.isSidechain, model: d.message?.model ?? null,
    uncached: n(u.input_tokens), w1h, w5m, read: n(u.cache_read_input_tokens), output: n(u.output_tokens), ttls,
  };
}

// A request's API-equivalent dollars, the cache writes apart, or null on a model with no price.
export function requestUsd(r) {
  const base = MODEL_PRICES[modelFamily(r.model)];
  if (!base) return null;
  const p = base.over && r.uncached + r.w1h + r.w5m + r.read > base.over.above ? base.over : base;
  const write = (r.w1h * p.write1h + r.w5m * p.write5m) / 1e6;
  return { write, total: write + (r.uncached * p.input + r.read * p.read + r.output * p.output) / 1e6 };
}

// Every .jsonl under a folder, subagent transcripts in session folders included.
function transcripts(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => (e.isDirectory() ? transcripts(join(dir, e.name)) : e.name.endsWith('.jsonl') ? [join(dir, e.name)] : []));
}

const emptyRow = () => ({ sessions: new Set(), requests: 0, uncached: 0, w1h: 0, w5m: 0, read: 0, output: 0, usd: 0, writeUsd: 0, unpriced: 0, ttls: new Set() });

// windows: [{ name, from, to }] in epoch ms, `to` exclusive. -> { windows: [{ name, from, to, rows: { <caller>: row } }],
// skipped, other } where `skipped` counts lines that are not JSON and `other` the sessions no caller claimed.
export function cacheReport({ dirs = projectsDirs(), windows }) {
  const out = windows.map((w) => ({ ...w, rows: Object.fromEntries(CALLERS.map((c) => [c, emptyRow()])) }));
  const earliest = Math.min(...windows.map((w) => w.from));
  const seen = new Set();
  const otherSessions = new Set();
  let skipped = 0;
  for (const file of [...new Set(dirs)].flatMap(transcripts)) {
    try { if (statSync(file).mtimeMs < earliest) continue; } catch { continue; }
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const lines = [];
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      try { lines.push(JSON.parse(l)); } catch { skipped += 1; }
    }
    const main = lines.filter((d) => d && !d.isSidechain);
    const first = main.find((d) => d.type === 'user' && textOf(d.message?.content));
    const caller = callerOf({ prompt: textOf(first?.message?.content), cwd: main.find((d) => d.cwd)?.cwd ?? '', entrypoint: main.find((d) => d.entrypoint)?.entrypoint ?? null });
    for (const d of lines) {
      const r = requestOf(d);
      if (!r || !Number.isFinite(r.at)) continue;
      if (r.id) { if (seen.has(r.id)) continue; seen.add(r.id); }
      const who = r.sidechain ? 'subagent' : caller;
      const usd = requestUsd(r);
      for (const w of out) {
        if (r.at < w.from || r.at >= w.to) continue;
        const row = w.rows[who];
        row.sessions.add(file);
        row.requests += 1;
        for (const k of ['uncached', 'w1h', 'w5m', 'read', 'output']) row[k] += r[k];
        for (const t of r.ttls) row.ttls.add(t);
        if (usd) { row.usd += usd.total; row.writeUsd += usd.write; } else row.unpriced += 1;
        if (who === 'other') otherSessions.add(file);
      }
    }
  }
  return { windows: out, skipped, other: otherSessions.size };
}

const tokens = (n) => Math.round(n).toLocaleString('en-US');
const usd = (n, places = 2) => `$${n.toFixed(places)}`;
const hit = (r) => { const all = r.uncached + r.w1h + r.w5m + r.read; return all ? `${((100 * r.read) / all).toFixed(1)}%` : '-'; };
const mixed = (r) => (r.ttls.has('5m') && r.ttls.has('1h') ? 'mixed TTL' : '');
const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const span = (w) => `${day(w.from)}..${day(w.to - 1)}`;

function table(head, rows) {
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (row) => `  ${row.map((c, i) => (i < 2 ? String(c).padEnd(width[i]) : String(c).padStart(width[i]))).join('  ')}`.trimEnd();
  return [line(head), ...rows.map(line)];
}

function notes(rep) {
  const unpriced = rep.windows.reduce((n, w) => n + Object.values(w.rows).reduce((m, r) => m + r.unpriced, 0), 0);
  return [`skipped ${rep.skipped} line(s) that are not JSON; ${rep.other} session(s) not attributed to a caller, counted as other`,
    ...(unpriced ? [`${unpriced} request(s) on a model with no price, left out of the dollars`] : [])];
}

const PRICES = Object.entries(MODEL_PRICES).map(([f, p]) => `${f} ${p.input}/${p.write1h}/${p.write5m}/${p.read}/${p.output}`).join(', ');
const HEAD = `dollars are API-equivalent at list prices per million tokens (input/1h write/5m write/read/output: ${PRICES}); hit ratio is cache reads over all input`;

// One window: a row per caller and a total.
export function windowText(rep) {
  const w = rep.windows[0];
  const total = emptyRow();
  for (const r of Object.values(w.rows)) {
    for (const k of ['requests', 'uncached', 'w1h', 'w5m', 'read', 'output', 'usd', 'writeUsd']) total[k] += r[k];
    for (const s of r.sessions) total.sessions.add(s);
    for (const t of r.ttls) total.ttls.add(t);
  }
  const cells = (name, r) => [name, r.sessions.size, r.requests, tokens(r.uncached), tokens(r.w1h), tokens(r.w5m), tokens(r.read), hit(r), usd(r.writeUsd), usd(r.usd), mixed(r)];
  const rows = [...CALLERS.map((c) => cells(c, w.rows[c])), cells('total', total)];
  return [`CACHE REPORT ${span(w)}: ${HEAD}`,
    ...table(['caller', 'sessions', 'requests', 'uncached', 'write 1h', 'write 5m', 'read', 'hit ratio', 'write $', '$', ''], rows),
    ...notes(rep).map((n) => `  (${n})`)].join('\n');
}

// Two windows: each caller's before and after, per request and per session, and the change in
// cache-write dollars per session.
export function compareText(rep) {
  const [before, after] = rep.windows;
  const per = (r, by, f) => (by ? f(by) : '-');
  const perReq = (r) => [r.sessions.size, r.requests, hit(r), ...['uncached', 'w1h', 'w5m', 'read'].map((k) => per(r, r.requests, (n) => tokens(r[k] / n))),
    per(r, r.requests, (n) => usd(r.writeUsd / n, 4)), per(r, r.requests, (n) => usd(r.usd / n, 4)), mixed(r)];
  const perSession = (r) => [...['uncached', 'w1h', 'w5m', 'read'].map((k) => per(r, r.sessions.size, (n) => tokens(r[k] / n))),
    per(r, r.sessions.size, (n) => usd(r.writeUsd / n, 4)), per(r, r.sessions.size, (n) => usd(r.usd / n, 4))];
  const change = (c) => {
    const [b, a] = [before.rows[c], after.rows[c]];
    if (!b.sessions.size || !a.sessions.size) return '-';
    const [x, y] = [b.writeUsd / b.sessions.size, a.writeUsd / a.sessions.size];
    const d = y - x;
    return `${d < 0 ? '-' : '+'}${usd(Math.abs(d), 4)}${x ? ` (${d < 0 ? '' : '+'}${((100 * d) / x).toFixed(0)}%)` : ''}`;
  };
  const reqRows = CALLERS.flatMap((c) => [[c, 'before', ...perReq(before.rows[c])], ['', 'after', ...perReq(after.rows[c])]]);
  const sesRows = CALLERS.flatMap((c) => [[c, 'before', ...perSession(before.rows[c]), ''], ['', 'after', ...perSession(after.rows[c]), change(c)]]);
  return [`CACHE REPORT before ${span(before)}, after ${span(after)}: ${HEAD}`,
    'Per request',
    ...table(['caller', 'window', 'sessions', 'requests', 'hit ratio', 'uncached', 'write 1h', 'write 5m', 'read', 'write $', '$', ''], reqRows),
    'Per session',
    ...table(['caller', 'window', 'uncached', 'write 1h', 'write 5m', 'read', 'write $', '$', 'change in write $'], sesRows),
    ...notes(rep).map((n) => `  (${n})`)].join('\n');
}

// A local day, `YYYY-MM-DD`, as the epoch ms it starts at, or NaN.
const dayStart = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s ?? '') ? new Date(`${s}T00:00:00`).getTime() : NaN);
const NEXT_DAY = 24 * 3600 * 1000;
// `<from>..<to>`, both days counted, as a window.
export function rangeWindow(name, s) {
  const [a, b] = String(s ?? '').split('..');
  const from = dayStart(a);
  const to = dayStart(b) + NEXT_DAY;
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? { name, from, to } : null;
}

// ---- CLI ---------------------------------------------------------------------------------------
const USAGE = 'usage: cache-report.mjs --since <YYYY-MM-DD> [--until <YYYY-MM-DD>]\n       cache-report.mjs --before <from>..<to> --after <from>..<to>';
export function windowsFromArgs(argv, now = Date.now()) {
  const opt = (k) => { const i = argv.indexOf(k); return i < 0 ? undefined : argv[i + 1] ?? ''; };
  if (opt('--before') !== undefined || opt('--after') !== undefined) {
    const ws = [rangeWindow('before', opt('--before')), rangeWindow('after', opt('--after'))];
    return ws.every(Boolean) ? ws : null;
  }
  if (opt('--since') === undefined) return null;
  const from = dayStart(opt('--since'));
  const to = opt('--until') === undefined ? now + 1 : dayStart(opt('--until')) + NEXT_DAY;
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? [{ name: 'window', from, to }] : null;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const windows = windowsFromArgs(process.argv.slice(2));
  if (!windows) { console.error(USAGE); process.exit(2); }
  const rep = cacheReport({ windows });
  console.log(windows.length === 2 ? compareText(rep) : windowText(rep));
}
