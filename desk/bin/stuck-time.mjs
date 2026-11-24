// Time stuck by cause: each park, hold and stall a ticket sits in, as an interval with its cause, and the
// hours per cause per repo per ISO week (UTC, Monday to Monday). A pass hands stuckStep the causes it
// sees each ticket in (a parked ticket's park kind and failure class; a spawn the pass held, for the
// tickets it kept waiting: usage, memory harm by signal, low memory, the lock, the test lock queue, a
// collision with a running ticket's files, a red base, a gate reviewer down) and the step diffs them
// against the batch's open intervals: a new cause opens one (from the park's `since`, else the pass's
// time), a cause gone closes it at the pass's time. Each opening and closing is one line of the repo's
// <state>/stuck-intervals.jsonl, appended (the latest line per interval wins, a cut line is skipped),
// and one `stuck` event in the ticket ledger where the ledger lever is on, written first:
//   { key, batch, created, cause, start, end (null while open), recorded }
// A batch's identity is <batch state>/stuck-batch.json, { name, created }, written by its first pass: the
// name its passes record intervals under (DESK_BATCH, null for the standing batch) and when that pass
// ran. An archive carries it with the batch's folder; a move retires the standing slot's, so the moved batch
// and the next standing batch each write their own. Every reader takes a batch's name and
// `created` from it alone (batchIdentity), falling back to the batch's listed name only where it is
// missing. A batch started later under a name an archived one had has a new folder, so it is another
// batch, which neither closes nor takes up the earlier one's intervals. Each pass also notes when
// it ran, per batch, in <state>/stuck-passes.json: a reader given the repo's live batches (liveOf) counts
// an interval still open in a batch that has gone (archived, discarded, or replaced by a later one of its
// name, so no pass will close it) as closed at that batch's last pass.
// A cause's tracking issue is set by hand, in <state>/stuck-links.json:
//   node stuck-time.mjs link <cause> <issue number | #N | URL>     node stuck-time.mjs unlink <cause>
//   node stuck-time.mjs                                            this week's and last week's lines
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './dir-lock.mjs';

const fileOf = (state) => join(state, 'stuck-intervals.jsonl');
const linksFile = (state) => join(state, 'stuck-links.json');
const passesFile = (state) => join(state, 'stuck-passes.json');
const batchFile = (batchState) => join(batchState, 'stuck-batch.json');
const HOUR_MS = 3600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const ms = (iso) => Date.parse(iso ?? '');
const pair = (key, cause) => `${key}\0${cause}`;
const ticketOf = (e) => `${e.batch ?? ''}\0${e.key}`;
// A batch as an interval and the passes record name it: its name and when it began.
const batchOf = (name, created) => `${name ?? ''}\0${created ?? ''}`;
const hours = (m) => Math.round((m / HOUR_MS) * 10) / 10;
// How many causes the line names.
const TOP = 3;

// A parked ticket's cause: its park kind (queue-states.mjs PARK_KINDS), and its failure class where set.
const parkCause = (kind, cls) => `park: ${kind ?? 'question'}${cls ? ` (${cls})` : ''}`;

// The cause of the spawn hold a pass's metrics count (`why`: usage, memory or lock) or, with none of
// those, of the hold that kept every spawn (`held`, pass/eligibility.mjs's words); `harm` is the
// newest memory harm signal (TMPFS-HIGH, VMMEM-HIGH, …) where one holds. Null where nothing held.
export function spawnHoldCause({ why = null, held = null, harm = null } = {}) {
  if (why === 'usage') return 'usage';
  if (why === 'memory') return harm ? `memory harm: ${harm}` : 'memory: low available';
  if (why === 'lock') return 'lock';
  if (!held) return null;
  return /maintenance/.test(held) ? 'maintenance' : /budget/.test(held) ? 'budget' : /health check/.test(held) ? 'health check' : 'config';
}

// Every interval recorded in repo state `state`, the latest line of each; none with no file, and null
// for a file that is there but cannot be read. A line that does not read is skipped.
function readAll(state) {
  let text = '';
  try { text = readFileSync(fileOf(state), 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? [] : null; }
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.key && e.cause && Number.isFinite(ms(e.start))) byId.set(`${batchOf(e.batch, e.created)}\0${e.key}\0${e.cause}\0${e.start}`, e);
    } catch { /* skipped */ }
  }
  return [...byId.values()];
}
const readIntervals = (state) => readAll(state) ?? [];
const readJson = (file) => {
  try { const v = JSON.parse(readFileSync(file, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

// The identity of the batch whose state folder is `batchState`, { name, created }, as its first pass
// wrote it; null where none is written.
export function batchIdentity(batchState) {
  const v = batchState ? readJson(batchFile(batchState)) : {};
  const ok = (v.name === null || (typeof v.name === 'string' && v.name)) && typeof v.created === 'string' && Number.isFinite(ms(v.created));
  return ok ? { name: v.name, created: v.created } : null;
}
// The repo's live batches as readers take them, from batch entries { name, state } (batches.mjs
// listBatches; an archived entry is left out): [{ name, created }], each from its identity, or its listed
// name and no `created` where it has none.
export const liveOf = (batches) => (batches ?? []).filter((b) => !b?.archived)
  .map((b) => batchIdentity(b.state) ?? { name: b.name ?? null, created: null });

// The intervals as a reader counts them: with `live` (liveOf), one still open in a batch not among them
// closes at that batch's last pass, or at its own record where none is noted. Null where the file
// cannot be read.
function counted(state, live) {
  const all = readAll(state);
  if (!all || !live) return all;
  const names = new Set(live.map((b) => batchOf(b.name, b.created)));
  const passes = readJson(passesFile(state));
  return all.map((e) => {
    if (e.end != null || names.has(batchOf(e.batch, e.created))) return e;
    const last = [e.recorded, passes[batchOf(e.batch, e.created)]].filter((x) => Number.isFinite(ms(x))).sort((a, b) => ms(a) - ms(b)).at(-1);
    return { ...e, end: last && ms(last) > ms(e.start) ? last : e.start };
  });
}

// One line appended; a line cut off mid-write before it stays a line of its own.
function record(state, entry) {
  const f = fileOf(state);
  mkdirSync(dirname(f), { recursive: true });
  let lead = '';
  try {
    const fd = openSync(f, 'r');
    try {
      const { size } = fstatSync(fd);
      const b = Buffer.alloc(1);
      if (size && readSync(fd, b, 0, 1, size - 1) === 1 && b[0] !== 10) lead = '\n';
    } finally { closeSync(fd); }
  } catch { /* a new file */ }
  appendFileSync(f, `${lead}${JSON.stringify(entry)}\n`);
}

// One pass's step for batch `batch` (null for the standing one), whose state folder is `batchState`
// (its first pass notes there when it began). `parked`: [{ key, kind, class, since }]
// for each parked ticket; `waits`: [{ key, cause }] for each ticket a hold or stall kept waiting this
// pass. `ledger(entry)`, where the ledger lever is on, appends its event under an id fixed by the
// interval and throws on a failed write: the change is then not recorded, so the next pass makes it
// again. -> the pass's report lines (only what could not be written).
export function stuckStep(state, { batch = null, batchState = null, parked = [], waits = [], ledger = null, now = new Date().toISOString() }) {
  let created = batchIdentity(batchState)?.created ?? null;
  if (batchState && !created) {
    try { writeJsonAtomic(batchFile(batchState), { name: batch, created: now }); created = now; } catch { /* written by the next pass */ }
  }
  const want = new Map();
  for (const p of parked) {
    if (!p?.key) continue;
    const since = Number.isFinite(ms(p.since)) && ms(p.since) <= ms(now) ? p.since : now;
    want.set(pair(p.key, parkCause(p.kind, p.class)), { key: p.key, cause: parkCause(p.kind, p.class), start: since });
  }
  for (const w of waits) if (w?.key && w.cause && !want.has(pair(w.key, w.cause))) want.set(pair(w.key, w.cause), { key: w.key, cause: w.cause, start: now });
  const open = readIntervals(state).filter((e) => e.end == null && batchOf(e.batch, e.created) === batchOf(batch, created));
  const lines = [];
  const write = (entry) => {
    const what = `${entry.key}'s ${entry.cause} interval`;
    if (ledger) {
      try { ledger(entry); } catch (e) { lines.push(`stuck time: ${what} could not be added to the ticket ledger (${String(e?.message ?? e).split('\n')[0]}); the next pass tries again`); return; }
    }
    try { record(state, entry); } catch (e) { lines.push(`stuck time: ${what} could not be recorded (${String(e?.message ?? e).split('\n')[0]})`); }
  };
  for (const e of open) {
    if (!want.has(pair(e.key, e.cause))) write({ key: e.key, batch, created, cause: e.cause, start: e.start, end: now, recorded: now });
  }
  const opened = new Set(open.map((e) => pair(e.key, e.cause)));
  for (const [k, w] of want) if (!opened.has(k)) write({ ...w, batch, created, end: null, recorded: now });
  try { writeJsonAtomic(passesFile(state), { ...readJson(passesFile(state)), [batchOf(batch, created)]: now }); } catch { /* the next pass notes it */ }
  return lines;
}

// The length of the union of spans [[a, b]].
function unionMs(spans) {
  let total = 0, end = -Infinity;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

// Each ticket's hours stuck up to `now` (an interval still open runs to it, or to its gone batch's last
// pass, `live` as counted takes it), overlapping causes counted once: a function of (batch, created, key,
// from) giving the hours of that batch's ticket from `from` (ms; the ticket's admission, so a ticket
// admitted again does not carry its earlier stay's), 0 with none recorded; null where the file cannot be
// read. A batch with no `created` (no identity) takes every interval of its name.
export function parkedHours(state, { now = Date.now(), live = null } = {}) {
  const all = counted(state, live);
  if (!all) return null;
  const spans = new Map();
  const add = (k, span) => spans.set(k, [...(spans.get(k) ?? []), span]);
  for (const e of all) {
    const a = ms(e.start), b = Math.min(e.end == null ? now : ms(e.end), now);
    if (!(b > a)) continue;
    add(ticketOf(e), [a, b]);
    if (e.created) add(`${batchOf(e.batch, e.created)}\0${e.key}`, [a, b]);
  }
  return (batch, created, key, from = -Infinity) => {
    const s = (spans.get(created ? `${batchOf(batch, created)}\0${key}` : `${batch ?? ''}\0${key}`) ?? [])
      .map(([a, b]) => [Math.max(a, from), b]).filter(([a, b]) => b > a);
    return hours(unionMs(s));
  };
}

const readLinks = (state) => readJson(linksFile(state));

// The Monday 00:00 UTC that starts the ISO week holding `t`, and the week's name, 2026-W48. A copy of
// levers-audit.mjs weekStart: that module reaches this one through levers-view, so importing it would
// make a cycle.
const weekStart = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); };
const weekName = (start) => {
  const thu = new Date(start + 3 * 24 * HOUR_MS);
  const y = thu.getUTCFullYear();
  return `${y}-W${String(Math.floor((thu - Date.UTC(y, 0, 1)) / WEEK_MS) + 1).padStart(2, '0')}`;
};

// Repo state `state`'s time stuck in the ISO week `weeksAgo` before the one holding `now`: the hours
// (each ticket's overlapping causes and batches counted once), the tickets affected, and each cause with its
// hours, tickets and tracking issue, most hours first (`live` as counted takes it):
//   { week, from, to, hours, tickets, causes: [{ cause, hours, tickets, link: { ref, url } | null }] }
export function weekSummary(state, { now = Date.now(), weeksAgo = 0, live = null } = {}) {
  const from = weekStart(now) - weeksAgo * WEEK_MS, to = from + WEEK_MS, upto = Math.min(to, now);
  const links = readLinks(state);
  // A ticket counts once, by its key, whichever batches it sat stuck in (a move reopens its park in the
  // new batch from the park's since, over the time the old batch's interval already holds): its spans,
  // and each cause's, are joined before they are summed.
  const byCause = new Map(), spans = new Map();
  const add = (m, k, span) => m.set(k, [...(m.get(k) ?? []), span]);
  for (const e of counted(state, live) ?? []) {
    const a = Math.max(ms(e.start), from), b = Math.min(e.end == null ? now : ms(e.end), upto);
    if (!(b > a)) continue;
    if (!byCause.has(e.cause)) byCause.set(e.cause, new Map());
    add(byCause.get(e.cause), e.key, [a, b]);
    add(spans, e.key, [a, b]);
  }
  const msOf = (m) => [...m.values()].reduce((n, s) => n + unionMs(s), 0);
  const causes = [...byCause].map(([cause, m]) => ({ cause, ms: msOf(m), tickets: m.size })).sort((x, y) => y.ms - x.ms)
    .map(({ cause, ms: m, tickets }) => ({ cause, hours: hours(m), tickets, link: links[cause] ?? null }));
  const total = msOf(spans);
  return { week: weekName(from), from: new Date(from).toISOString(), to: new Date(to).toISOString(), hours: hours(total), tickets: spans.size, causes };
}

export const fmtHours = (h) => `${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
const many = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The summary as one line, or null with no ticket stuck that week.
export function stuckLine(s) {
  if (!s?.tickets) return null;
  const top = s.causes.slice(0, TOP).map((c) => `${c.cause} ${fmtHours(c.hours)} (${many(c.tickets, 'ticket')}${c.link ? `, ${c.link.ref}` : ''})`);
  return `time parked by cause, week ${s.week}: ${fmtHours(s.hours)} over ${many(s.tickets, 'ticket')}; top: ${top.join(' · ')}`;
}

// What `link` stores for an issue number, #N or URL; null for anything else.
function linkOf(target, ghRepo) {
  const n = /^#?(\d+)$/.exec(target ?? '');
  if (n) return { ref: `#${n[1]}`, url: ghRepo ? `https://github.com/${ghRepo}/issues/${n[1]}` : null };
  if (!/^https?:\/\/\S+$/.test(target ?? '')) return null;
  const i = /\/(?:issues|pull|browse)\/([A-Z][A-Z0-9]*-\d+|\d+)\b/.exec(target);
  return { ref: i ? (/^\d+$/.test(i[1]) ? `#${i[1]}` : i[1]) : target, url: target };
}

const isMain = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
// Run once this module has loaded, not awaited at its top level: batches.mjs imports this module, so
// awaiting its import here would wait on this module's own loading.
async function main() {
  const [cmd, cause, target] = process.argv.slice(2);
  const usage = 'usage: stuck-time.mjs [link <cause> <issue number | #N | URL> | unlink <cause>]';
  try {
    const E = await import('./desk-env.mjs');
    const state = E.repoStateOf(E.stateDir());
    if (cmd == null) {
      const { listBatches } = await import('./batches.mjs');
      let live = null;
      try { live = liveOf(listBatches(E.repoSlug())); } catch { /* every batch read as live */ }
      for (const weeksAgo of [0, 1]) {
        const s = weekSummary(state, { weeksAgo, live });
        console.log(stuckLine(s) ?? `time parked by cause, week ${s.week}: none recorded`);
      }
    } else if (cmd === 'link' && cause && target) {
      let gh = null;
      try { gh = E.ghRepo(); } catch { /* the issue number alone */ }
      const link = linkOf(target, gh);
      if (!link) { console.error(`stuck-time: "${target}" is not an issue number, #N or URL\n${usage}`); process.exit(2); }
      writeJsonAtomic(linksFile(state), { ...readLinks(state), [cause]: link });
      console.log(`stuck-time: ${cause} → ${link.ref}${link.url && link.url !== link.ref ? ` (${link.url})` : ''}`);
    } else if (cmd === 'unlink' && cause) {
      const links = readLinks(state);
      if (!(cause in links)) { console.error(`stuck-time: no link for "${cause}"`); process.exit(1); }
      delete links[cause];
      writeJsonAtomic(linksFile(state), links);
      console.log(`stuck-time: ${cause} unlinked`);
    } else { console.error(usage); process.exit(2); }
  } catch (e) {
    console.error(`stuck-time: ${e.message ?? e}`);
    process.exit(1);
  }
}
if (isMain()) main();
