#!/usr/bin/env node
// desk-q: every autopilot queue on this computer, from the files alone. It reads the repo configs,
// each repo's queue.json, its orchestrator heartbeats and its triage records. Repos are found on
// disk every run, so a newly set-up repo appears with no change here.
//
//   desk-q [--plain] [--all]             one line per batch: live first, then quiet ones that need you
//   desk-q [--plain] <repo>              that repo's unfinished tickets in spawn order
//   desk-q [--plain] <repo> show <KEY>   one ticket in full
//   desk-q ships [<repo>]                the Timeline: a bar per unfinished ticket from when it starts
//                                        to when it ships (`when` too), and in one repo with an epic, a bar
//                                        per epic first; with --plain, one line per ticket, then one per
//                                        epic with children in the queue
//   desk-q <repo> days, desk-q days      By day: the tickets grouped by the day they ship
//   desk-q <repo> up|down|top|bottom <KEY>   move a ticket in the spawn order (queue.mjs move)
//   desk-q <repo> move <KEY> <n>         put it at position n of the unfinished tickets
//   desk-q <repo> workers <n>            the batch's worker count (queue.mjs set-batch), up to the cap
//
// A repo is named by its short name or any unique prefix of it. In a terminal, without --plain,
// the same views open full-screen, with arrow keys, Enter and Esc, Tab or 1–4 for a place's Queue,
// Timeline, By day and Epics, and clicks on the breadcrumb, the tabs and the rows; piped output gets the plain text.
// The only queue writes are the move and workers commands, each a queue.mjs command against the queue
// of the repo named. The one other write is a repo's <state>/eta.jsonl, which gains a ticket's first
// ship estimate the first time a live batch's forecast dates it.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { HOME, deskHome, deskConfigRoot, repoPortClaims, portClashes, repoConfigValue, concurrencyLimits, machineWhy, availableGiB, spawnGate } from './desk-env.mjs';
import { isHeld, waitingOnMerge, readJsonOrRefuse, describeCrash, batchConcurrency } from './batch-state.mjs';
import { RULES } from './machine.mjs';
import { LIVE_MS, lastBeat, liveBeat, machineCap } from './borrow.mjs';
import { readHistory, recentHistory, sizeOf, forecast, epicsOf, durations, durationsFor, quantile, when, dayAndTime, nextCheckin, dayAt, calendarDays, HOUR, DAY, RUNS, MIN_HISTORY, WINDOW_DAYS,
  readEstimates, saveEstimates, hitRate, MIN_HITS } from './desk-q-eta.mjs';

export { LIVE_MS };
const LABEL = { running: 'running', ready: 'ready', queued: 'queued', waiting: 'waiting', stuck: 'stuck', needs: 'needs you', failed: 'failed', done: 'done' };

const pad = (s, n) => { s = String(s ?? ''); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
const rpad = (s, n) => { s = String(s ?? ''); return ' '.repeat(Math.max(0, n - s.length)) + s; };
const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const ago = (ms) => {
  if (ms == null) return 'never';
  const m = Math.floor(ms / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
};
function wrap(s, w) {
  const out = []; let line = '';
  for (const word of String(s ?? '').split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > w) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

// A title's leading tag ("autopilot: ", "Your day 7/14: "): its length with the space after it, and
// an id that drops any "n/m" count, so "Your day 7/14" and "Your day 8/14" are one tag.
const tagOf = (s) => {
  const m = /^([^:]{1,28}):\s+/.exec(s ?? '');
  return m ? { len: m[0].length, id: m[1].replace(/\s*\d+\s*\/\s*\d+\s*$/, '').trim().toLowerCase() } : null;
};

// Titles for one list: a tag that starts at least half of them is dropped, because it tells those
// rows apart from nothing. A tag fewer share stays.
export function titler(titles) {
  const n = {};
  for (const s of titles) { const g = tagOf(s); if (g) n[g.id] = (n[g.id] ?? 0) + 1; }
  return (s) => { const g = tagOf(s); return g && n[g.id] >= 2 && n[g.id] * 2 >= titles.length ? s.slice(g.len) : s ?? ''; };
}

// ---- reading ---------------------------------------------------------------------------------

// The shown state: "parked" splits three ways with waitingOnMerge, the orchestrator's own test. A
// queued ticket has not been triaged yet, so it is not ready either.
export function shownState(q, t) {
  if (['running', 'done', 'failed'].includes(t.state)) return t.state;
  if (isHeld(t)) return waitingOnMerge(q, t) ? 'waiting' : 'stuck';
  if (t.state === 'parked' || (t.open_questions ?? 0) > 0) return 'needs';
  return t.state === 'queued' ? 'queued' : 'ready';
}

// A hold's blockers less those done with a PR. The queue does not record merges and nothing here
// calls GitHub, so a done one with a PR is merged or about to be, and is left out.
export const unmergedBlockers = (q, t) => String(t.held_by ?? '').split('|').filter(Boolean)
  .filter((p) => { const pt = q.tickets?.[p]; return !(pt?.state === 'done' && pt.result?.pr != null); });

function triageOf(stateDir, key) {
  const p = join(stateDir, 'triage', `${key}.json`);
  if (!existsSync(p)) return null;
  try { return readJsonOrRefuse(p, `re-run triage.sh ${key}`); } catch { return { summary: '(triage record unreadable)' }; }
}

// Every set-up repo, with its batch where it has one. A queue that will not parse is reported on
// its repo rather than stopping the rest.
export function loadRepos(now = Date.now()) {
  const claims = repoPortClaims();
  const short = claims.map((c) => c.slug.split('__').slice(1).join('__') || c.slug);
  return claims.map((c, i) => {
    const name = short.filter((n) => n === short[i]).length > 1 ? c.slug.replace('__', '/') : short[i];
    const stateDir = join(HOME, '.desk-autopilot', c.slug);
    const queuePath = join(deskHome(), 'repos', c.slug, 'queue.json');
    const limits = concurrencyLimits(repoConfigValue(c.slug, 'concurrency'));
    const r = { name, slug: c.slug, claim: c, stateDir, queuePath, cap: limits.cap, q: null, error: null };
    if (existsSync(queuePath)) {
      try { r.q = readJsonOrRefuse(queuePath, 'restore it, or start a new batch there'); } catch (e) { r.error = describeCrash(e); }
    }
    const beat = lastBeat(stateDir, queuePath);
    r.last = beat?.at ?? null;
    r.next = beat?.next ?? null;
    r.live = liveBeat(beat, now);
    const rows = Object.values(r.q?.tickets ?? {});
    // A row's place is queue.mjs's: its position among the unfinished tickets, where a failed one
    // keeps its slot and has no place.
    let place = 0;
    r.rows = rows.filter((t) => t.state !== 'done').map((t) => ({ t, k: shownState(r.q, t), pos: t.state === 'failed' ? null : ++place }));
    r.places = place;
    r.done = rows.length - r.rows.length;
    r.workers = r.q ? batchConcurrency(r.q, limits).n : null;
    return r;
  });
}

const count = (r, k) => r.rows.filter((x) => (Array.isArray(k) ? k : [k]).includes(x.k)).length;
const attention = (r) => count(r, ['needs', 'stuck', 'failed']);
const hasBatch = (r) => r.q != null || r.error != null;

// Live batches first, freshest first; then quiet ones with something for the user, most first.
export function shownRepos(repos, all) {
  const b = repos.filter(hasBatch);
  const live = b.filter((r) => r.live).sort((a, c) => c.last - a.last);
  const quiet = b.filter((r) => !r.live && (all || r.error || attention(r) > 0)).sort((a, c) => attention(c) - attention(a));
  return [...live, ...quiet];
}

// ---- ship dates --------------------------------------------------------------------------------

const MINUTE = 60_000;
const forecasts = new Map();

// The repo's forecast, or null with no batch. Worked out to the minute and kept, so the screen's
// 2-second reread runs the simulation again only when the queue, the history or the minute changes.
// A batch that is not live (liveBeat: no pass for LIVE_MS, and no next pass recorded that is still to
// come) is `paused`: its dates assume passes that are not happening, so
// they are not shown and not saved. A live forecast saves each ticket's first estimate (eta.jsonl);
// one dated at the next check-in (c) is a what-if, and saves nothing.
export function forecastOf(r, { now = Date.now(), checkin = false } = {}) {
  if (!r.q) return null;
  const at = Math.floor(now / MINUTE) * MINUTE;
  const history = recentHistory(readHistory(r.stateDir), at);
  const list = (s) => String(s ?? '').split('|').filter(Boolean);
  const ep = epicsOf(r.q.tickets ?? {}, Object.fromEntries(Object.keys(r.q.tickets ?? {}).map((k) => [k, triageOf(r.stateDir, k)])));
  const rows = r.rows.map(({ t, k }) => ({ key: t.key, k, size: sizeOf(r.stateDir, t.key), stage: t.stage ?? null, held: list(t.held_by), collides: list(t.collides_with), epic: ep.of[t.key] ?? null }));
  // An epic with nothing left to run has shipped, so it is not run forward.
  const open = Object.fromEntries(Object.values(ep.epics).filter((e) => e.queued || e.missing > 0).map((e) => [e.key, { missing: e.missing }]));
  const id = JSON.stringify([r.slug, at, checkin, r.live, r.workers, rows, open, history.map((l) => [l.key, l.size, l.hours])]);
  if (!forecasts.has(id)) {
    if (forecasts.size > 64) forecasts.clear();
    const sizes = Object.fromEntries(rows.map((x) => [x.key, x.size]));
    const F = { ...forecast({ rows, workers: r.workers, history, now: at, checkin, epics: open }), d: durations(history), sizes, paused: !r.live, epics: ep.epics, of: ep.of, noEpic: ep.noEpic };
    // A state directory desk-q cannot write to costs the saved estimate, never the screen.
    if (!F.none && !F.paused && !checkin) try { saveEstimates(r.stateDir, F.T, at); } catch { /* shown, not saved */ }
    forecasts.set(id, F);
  }
  return forecasts.get(id);
}

const SOON = MINUTE;
const etaOf = (F, key) => (F && !F.none && !F.paused ? F.T[key] : null);
// With passes stopped there are no dates, but a running worker carries on, so its row says so.
const startsCell = (F, x, now) => {
  if (F && !F.none && F.paused) return x.k === 'running' ? 'running' : '—';
  const e = etaOf(F, x.t.key);
  return !e ? '—' : e.start <= now + SOON ? (x.k === 'running' ? 'running' : 'now') : when(e.start, now);
};
const shipsCell = (F, x, now) => (!F || F.none || F.paused ? '—' : F.T[x.t.key] ? when(F.T[x.t.key].likely, now) : 'no date');
const noHistory = (r, F) => `No ship estimate: ${r.name} has ${F.count} merged autopilot tickets in its history (the last ${WINDOW_DAYS} days), and estimates need ${MIN_HISTORY}.`;
const pausedNote = (r, now) => `Dates paused: ${r.last == null ? 'no pass yet' : `no pass for ${ago(now - r.last).replace(' ago', '')}`}. `
  + 'The forecast assumes passes keep running, so dates show again at the next pass.';

// How often the repo's saved first estimates held, for a ships view's header.
function hitLine(r) {
  const h = hitRate(readEstimates(r.stateDir));
  return h.pct == null ? `No hit rate yet: ${h.n} merged ticket${h.n === 1 ? ' has' : 's have'} a saved first estimate, and a rate needs ${MIN_HITS}.`
    : `${h.pct}% shipped before their could-run-to time (last ${h.n} tickets)`;
}
const typical = (F, key) => quantile(durationsFor(F.d, F.sizes[key]).v, 0.5).toFixed(1);
const listed = (keys) => keys.join(', ');

// The blockers in this queue that the forecast could not date.
const undatedBlockers = (r, F, t) => String(t.held_by ?? '').split('|').filter((b) => r.q.tickets[b] && r.rows.some((y) => y.t.key === b) && !etaOf(F, b));

// Why a ticket has no date, short enough for a row.
function undatedWhy(r, F, x) {
  if (r.workers === 0) return 'workers set to 0: nothing starts';
  if (x.k === 'needs') return `waiting on you · ~${typical(F, x.t.key)} h once answered`;
  if (x.k === 'stuck') return `stuck behind ${listed(unmergedBlockers(r.q, x.t))}`;
  if (x.k === 'failed') return 'failed: requeue it';
  const b = undatedBlockers(r, F, x.t);
  return b.length ? `after ${listed(b)}, which ${b.length > 1 ? 'have' : 'has'} no date` : '';
}

// The ticket screen's Starts and Ships lines.
function etaLines(r, F, x, now) {
  if (!F) return [];
  if (F.none) return [noHistory(r, F), ''];
  if (F.paused) return [`Ships: ${pausedNote(r, now)}`, ''];
  const key = x.t.key, e = F.T[key];
  if (!e) {
    const b = x.k === 'stuck' ? unmergedBlockers(r.q, x.t) : undatedBlockers(r, F, x.t);
    const why = r.workers === 0 ? 'No date: workers are set to 0, so nothing starts.'
      : x.k === 'needs' ? 'No date until you answer it. Press c to date it at the next check-in.'
        : x.k === 'stuck' ? `No date while it is stuck behind ${listed(b)}. Unblock ${b.length > 1 ? 'them' : 'it'} to date it.`
          : x.k === 'failed' ? 'No date: it failed. Requeue it to date it.'
            : `No date until ${listed(b)} ${b.length > 1 ? 'have dates' : 'has a date'}.`;
    return [`Ships: ${why}`, ''];
  }
  const start = e.start <= now + SOON ? (x.k === 'running' ? 'running now' : 'now') : when(e.start, now);
  const size = F.sizes[key];
  const { v, own } = durationsFor(F.d, size);
  // Drawn from the whole history, the line still says how many of this size it holds, or that triage gave none.
  const n = F.d.bySize[size]?.length ?? 0;
  const of = own ? '' : size === 'unknown' ? ' (triage recorded no size)' : ` (${n} of size ${size}${n ? ', too few to use alone' : ''})`;
  return [
    `Starts: ${start}   Ships: ${when(e.likely, now)}   Could run to ${when(e.late, now)} (1 run in 5 is later)`,
    `From ${v.length} merged ${own ? `size ${size} ` : ''}tickets in ${r.name}${of}: typical ${quantile(v, 0.5).toFixed(1)} h spawn to merge, 4 in 5 within ${quantile(v, 0.8).toFixed(1)} h.`,
    '',
  ];
}

// When the repo's last dated ticket ships.
function queueDone(r, now, checkin) {
  const F = forecastOf(r, { now, checkin });
  return !F ? '' : F.none ? 'no history' : F.paused ? 'paused' : F.clears ? when(F.clears, now) : 'no date yet';
}

// `desk-q ships [<repo>]`: one line per unfinished ticket, the form Claude reads.
export function shipsScreen(repos, slug, { now = Date.now(), checkin = false } = {}) {
  const s = etaScope(repos, slug, { now, checkin });
  if (!s.list.length) return nothingToDate;
  const out = [];
  const table = (r, F) => {
    out.push(`  ${pad('TICKET', 10)}${pad('STATE', 11)}${pad('STARTS', 13)}SHIPS`);
    for (const x of r.rows) {
      out.push(`  ${pad(x.t.key, 10)}${pad(LABEL[x.k], 11)}${pad(startsCell(F, x, now), 13)}${pad(shipsCell(F, x, now), 14)}${etaOf(F, x.t.key) ? '' : undatedWhy(r, F, x)}`.trimEnd());
    }
    if (!r.rows.length) out.push('  No unfinished tickets.');
  };
  for (const { r, F, note, stopped } of s.per) {
    if (out.length) out.push('');
    // Passes stopped: no dates, but the rows still say what is running.
    if (stopped) {
      const [pass, ...more] = passLines(r, now);
      out.push(`${r.name} · ${pass}`, ...more);
      table(r, stopped);
      continue;
    }
    if (note) { out.push(note); continue; }
    out.push(forecastLine(r.name, now, F.count, r.workers, checkin), passLines(r, now)[0], hitLine(r));
    table(r, F);
    out.push(`Queue done: ${F.clears ? when(F.clears, now) : 'no ticket has a date yet'}${F.undated ? `, ${F.undated} with no date` : ''}.`);
    const epics = Object.values(F.epics);
    if (!epics.length) continue;
    out.push('', `  ${pad('EPIC', 10)}${pad('TITLE', 32)}${pad('DONE', 7)}${pad('STARTS', 13)}SHIPS`);
    for (const e of epics) out.push(epicLine(r, F, e, now, checkin));
    if (F.noEpic) out.push(`Other work: ${F.noEpic} ticket${F.noEpic === 1 ? '' : 's'} with no epic.`);
  }
  return out.join('\n');
}

// Why an epic has no date: its undated children, by what holds them.
function epicWhy(r, F, e, checkin) {
  if (r.workers === 0) return 'No date: workers set to 0, so nothing starts';
  const undated = r.rows.filter((x) => F.of[x.t.key] === e.key && !F.T[x.t.key]);
  const c = (k) => undated.filter((x) => x.k === k).length;
  const why = [['needs', 'waiting on you'], ['stuck', 'stuck'], ['failed', 'failed']].filter(([k]) => c(k)).map(([k, w]) => `${c(k)} ${w}`);
  const rest = undated.length - c('needs') - c('stuck') - c('failed');
  if (rest) why.push(`${rest} behind those`);
  return `No date: ${why.join(', ')}${c('needs') && !checkin ? ' · c to date them at check-ins' : ''}`;
}

// One epic's line: key, title, children done of total, then STARTS and SHIPS, shipped, or why it has no date.
function epicLine(r, F, e, now, checkin) {
  const lead = `  ${pad(e.key, 10)}${pad(cut(e.summary, 30), 32)}${pad(`${e.done}/${e.total}`, 7)}`;
  if (!e.queued && !e.missing) return `${lead}${pad('—', 13)}shipped${e.shipped != null ? ` ${when(e.shipped, now)}` : ''}${e.missing == null ? ' · children not read' : ''}`;
  const d = F.E[e.key];
  if (!d) return `${lead}${pad('—', 13)}${epicWhy(r, F, e, checkin)}`;
  const running = r.rows.some((x) => F.of[x.t.key] === e.key && x.k === 'running');
  const starts = d.start == null ? '—' : d.start <= now + SOON ? (running ? 'running' : 'now') : when(d.start, now);
  return `${lead}${pad(starts, 13)}${pad(when(d.likely, now), 14)}${epicNote(e, d)}`.trimEnd();
}

// A dated epic's note: why it is provisional, else the child that sets its date.
const epicNote = (e, d) => (e.missing == null ? 'provisional: children not read' : e.missing ? `provisional: ${e.missing} not queued` : d.setBy ? `set by ${d.setBy}` : '');

// An epic's name as people say it: its summary up to the first colon or dash, else its key.
const epicShort = (e) => String(e?.summary ?? '').split(/:| — | - /)[0].trim() || e?.summary?.trim() || e?.key || '';
// The epics the forecast runs forward: a child unfinished, or one not queued yet.
const openEpics = (F) => Object.values(F?.epics ?? {}).filter((e) => F.E && e.key in F.E);
// Provisional while some children are not queued, or the list of them could not be read.
const provisional = (e) => e.missing !== 0;
// "started" once a child is done or running.
const epicStarts = (r, F, e, d, now) => (e.done > 0 || r.rows.some((x) => F.of[x.t.key] === e.key && x.k === 'running') ? 'started'
  : d.start == null ? '—' : d.start <= now + SOON ? 'now' : when(d.start, now));
// Whether the epic still has an unfinished ticket in this repo's queue.
const epicIn = (r, F, key) => !!F?.epics?.[key] && r.rows.some((x) => F.of[x.t.key] === key);

// ---- Timeline and By day -----------------------------------------------------------------------

// What z cycles through on the Timeline, auto first.
export const ZOOMS = ['auto', 'hours', 'days', 'weeks'];
// A row's colour, as an SGR code, by its shown state; DIM and BOLD for the rails and group rows.
const STATE_SGR = { running: '32', ready: '34', queued: null, waiting: '33', stuck: '31', needs: '35', failed: '31' };
const DIM = '2', BOLD = '1';
const dmy = (t) => dayAndTime(t).slice(0, -6);
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The Timeline's scale, from how far away the last could-run-to time is: hours up to 2 days, days
// up to 21, weeks beyond; `zoom` other than auto overrides it. Ticks are labelled local times.
export function scaleFor(dur, now, zoom = 'auto') {
  const id = zoom !== 'auto' ? zoom : dur <= 2 * DAY ? 'hours' : dur <= 21 * DAY ? 'days' : 'weeks';
  const ticks = [];
  let span;
  if (id === 'hours') {
    span = Math.min(48, Math.max(12, Math.ceil(dur / HOUR / 6) * 6)) * HOUR;
    const h0 = Math.ceil((now - dayAt(now, 0)) / (6 * HOUR)) * 6;
    for (let h = h0, t; (t = dayAt(now, 0, h)) < now + span; h += 6) {
      ticks.push({ t, label: new Date(t).getHours() === 0 ? dmy(t).slice(0, 3) : dayAndTime(t).slice(-5) });
    }
  } else if (id === 'days') {
    const days = Math.min(28, Math.max(3, Math.ceil(dur / DAY) + 1));
    span = days * DAY;
    for (let i = 1, t; (t = dayAt(now, i)) < now + span; i++) ticks.push({ t, label: dmy(t).split(' ').slice(0, 2).join(' ') });
  } else {
    const weeks = Math.min(16, Math.max(3, Math.ceil(dur / 7 / DAY) + 1));
    span = weeks * 7 * DAY;
    const monday = (8 - new Date(now).getDay()) % 7 || 7;
    for (let i = monday, t; (t = dayAt(now, i)) < now + span; i += 7) ticks.push({ t, label: dmy(t).split(' ').slice(1).join(' ') });
  }
  return { id, span, ticks };
}

// One row drawn in coloured runs: `segs` is [text, SGR code or null] pairs, `line` their plain text.
// Trailing blanks are trimmed across runs, as a plain row's are.
const segRow = (id, segs, open) => {
  while (segs.length > 1 && !segs.at(-1)[0].trim()) segs.pop();
  const last = segs.at(-1);
  if (last) last[0] = last[0].trimEnd();
  return { id, segs, line: segs.map((s) => s[0]).join(''), open };
};

// The repos a ships view dates: one repo, or every repo with a batch. `per` holds each in order with
// its forecast, or a note saying why it has none; `items` is every unfinished ticket of the dated ones,
// or with `epic`, of that epic only.
function etaScope(repos, slug, { now, checkin, epic = null }) {
  const list = slug ? repos.filter((r) => r.slug === slug) : repos.filter(hasBatch);
  const per = list.map((r) => {
    if (r.error) return { r, note: `${r.name} · queue unreadable: ${r.error}` };
    if (!r.q) return { r, note: `${r.name} · no autopilot batch yet, so nothing to date.` };
    const F = forecastOf(r, { now, checkin });
    return F.none ? { r, note: `${r.name} · ${noHistory(r, F)}` } : F.paused ? { r, note: `${r.name} · ${pausedNote(r, now)}`, stopped: F } : { r, F };
  });
  const dated = per.filter((p) => p.F);
  const notes = per.filter((p) => p.note).map((p) => p.note);
  const items = dated.flatMap(({ r, F }) => r.rows.filter((x) => !epic || F.of[x.t.key] === epic).map((x) => ({ r, F, x, e: etaOf(F, x.t.key) })));
  // One repo's view adds its hit rate; every repo's leaves it to each repo's own. An epic's names it.
  const ep = epic ? dated[0]?.F.epics[epic] : null;
  const head = !dated.length ? [] : [forecastLine(slug ? list[0].name : 'Every repo', now, dated.reduce((a, d) => a + d.F.count, 0), slug ? list[0].workers : null, checkin)
    + (ep ? ` · ${ep.key}: ${ep.done} of ${ep.total} children done` : ''), ...(slug ? [hitLine(list[0])] : [])];
  return { list, per, notes, items, head };
}

// A ships view's first line; `workers` null leaves the count out, as every repo's view does.
const forecastLine = (name, now, count, workers, checkin) => `${name} · forecast from ${dayAndTime(now)} · ${RUNS.toLocaleString('en-GB')} runs over ${count} merged tickets`
  + `${workers == null ? '' : ` · ${workers} workers`}${checkin ? ' · parked dated at the next check-in' : ''}`;

// A ticket row's key and state, the state in its colour.
const ticketLead = (i, indent) => [[`${indent}${pad(i.x.t.key, 10)}`, null], [pad(LABEL[i.x.k], 10), STATE_SGR[i.x.k]]];
const why = (i) => capital(undatedWhy(i.r, i.F, i.x)) || 'No date yet';
// A ticket opened from an epic's views keeps the epic, so Esc and the breadcrumb lead back to it.
const openTicket = (i, epic = null) => ({ kind: 'ticket', slug: i.r.slug, key: i.x.t.key, ...(epic ? { epic } : {}) });
const summaryOf = (i) => triageOf(i.r.stateDir, i.x.t.key)?.summary ?? '';
const nothingToDate = 'No repo here has an autopilot batch, so there is nothing to date.';

// The label columns before a Timeline bar, the STARTS and SHIPS after it (behind its end mark), and
// the gap before TITLE.
const TL_LEAD = 2 + 20 + 1, TL_TAIL = 2 + 13 + 12, TL_GAP = 2, TL_BAR = 64;
// By epic, the name and children-done columns before the bar, and the note after SHIPS.
const EP_NAME = 27, EP_LEAD = 2 + EP_NAME + 5 + 1, EP_NOTE = '  provisional'.length;

// One bar per ticket from STARTS to SHIPS, shaded on to its could-run-to time, sorted by ship time,
// each row ending in its title; every repo's view groups them under a row per repo. `width` null is the plain
// output. The bar and the title share what the row has left, the bar taking at most TL_BAR.
// One repo with an open epic is by feature instead: a bar per epic from its first child's start to its
// last child's ship, then the tickets in no epic under "Other work", each led by its title. `epic` keeps
// to that epic's tickets.
function timelineParts(repos, slug, { now = Date.now(), width = null, checkin = false, zoom = 'auto', epic = null } = {}) {
  const s = etaScope(repos, slug, { now, checkin, epic });
  if (!s.list.length) return { head: [nothingToDate], rows: [], foot: [] };
  if (!s.items.length && s.notes.length) return { head: s.notes, rows: [], foot: [] };
  const F0 = slug && !epic ? s.per[0]?.F : null;
  const epics = openEpics(F0).map((e) => ({ e, d: F0.E[e.key] })).sort((a, b) => (a.d?.likely ?? Infinity) - (b.d?.likely ?? Infinity));
  const byEpic = epics.length > 0;
  const items = byEpic ? s.items.filter((i) => !i.F.of[i.x.t.key]) : s.items;
  const lead = byEpic ? EP_LEAD : TL_LEAD;
  const spare = width == null ? null : width - lead - TL_TAIL - (byEpic ? EP_NOTE : TL_GAP);
  const cw = width == null ? TL_BAR : Math.max(12, Math.min(TL_BAR, byEpic ? spare : Math.ceil(spare / 2)));
  const tw = width == null ? 60 : Math.max(1, spare - cw);
  const tt = titler(items.map(summaryOf));
  const title = (i) => [`${' '.repeat(TL_GAP)}${cut(tt(summaryOf(i)), tw)}`, null];
  const dated = items.filter((i) => i.e).sort((a, b) => a.e.likely - b.e.likely);
  const undated = items.filter((i) => !i.e);
  const ends = [...dated.map((i) => i.e.late), ...epics.filter((x) => x.d).map((x) => x.d.late)];
  const sc = scaleFor((ends.length ? Math.max(...ends) : now + DAY) - now, now, zoom);
  const col = (t) => Math.floor(((t - now) / sc.span) * cw);
  const rails = new Set();
  if (sc.id === 'hours' || (sc.id === 'days' && sc.span <= 8 * DAY)) for (let c = nextCheckin(now); c != null && c < now + sc.span; c = nextCheckin(c)) rails.add(col(c));
  const lab = Array(cw).fill(' '), tick = Array(cw).fill('─');
  for (const { t, label } of sc.ticks) {
    const c = col(t);
    if (c < 5 || c >= cw) continue;
    tick[c] = '┬';
    if (c + label.length <= cw && lab.slice(Math.max(0, c - 1), c + label.length + 1).every((ch) => ch === ' ')) [...label].forEach((ch, j) => { lab[c + j] = ch; });
  }
  for (const c of rails) if (c >= 0 && c < cw) tick[c] = '▾';
  tick[0] = '├';
  [...'now'].forEach((ch, j) => { lab[j] = ch; });
  const ind = ' '.repeat(lead);
  const head = [...s.head, `Scale: ${sc.id}${zoom === 'auto' ? ' (auto)' : ''}${width == null ? '' : ' · z to change'}`, ''];
  if (s.items.length) head.push(`${ind}${lab.join('')}  ${pad('STARTS', 13)}${byEpic ? 'SHIPS' : `${pad('SHIPS', 12 + TL_GAP)}TITLE`}`, `${ind}${tick.join('')}`);
  // Each run of bar glyphs is one segment, so it is coloured once and cut as a whole.
  const bar = (e, sgr) => {
    const a = Math.max(0, col(e.start)), b = Math.max(a, col(e.likely)), c = Math.max(b, col(e.late));
    const out = [];
    for (let j = 0; j < cw; j++) {
      const [ch, k] = j >= a && j <= b ? ['█', sgr] : j > b && j <= c ? ['░', sgr] : [rails.has(j) ? '┆' : ' ', DIM];
      if (out.length && out.at(-1)[1] === k) out.at(-1)[0] += ch; else out.push([ch, k]);
    }
    out.push(c >= cw ? ['▸', sgr] : [' ', null]);
    return out;
  };
  const rows = [];
  if (byEpic) {
    const r = s.per[0].r;
    for (const { e, d } of epics) {
      const name = [[`  ${pad(cut(epicShort(e), EP_NAME - 1), EP_NAME)}`, null], [rpad(`${e.done}/${e.total}`, 5), DIM], [' ', null]];
      const open = { kind: 'epic', slug: r.slug, epic: e.key };
      if (!d) { rows.push(segRow(`${r.slug} ${e.key}`, [...name, [epicWhy(r, F0, e, checkin), STATE_SGR.needs]], open)); continue; }
      const sgr = provisional(e) ? STATE_SGR.waiting : BOLD;
      rows.push(segRow(`${r.slug} ${e.key}`, [...name, ...bar({ start: d.start ?? now, likely: d.likely, late: d.late }, sgr),
        [` ${pad(epicStarts(r, F0, e, d, now), 13)}${pad(when(d.likely, now), 12)}`, null], ...(provisional(e) ? [['  provisional', sgr]] : [])], open));
    }
    if (items.length) rows.push(segRow(`${r.slug} other`, [['  Other work', BOLD], [` · ${items.length} ticket${items.length === 1 ? '' : 's'} with no epic`, DIM]], null));
  }
  // By epic, a ticket is led by its title and has no TITLE column.
  const tlead = (i) => (byEpic ? [[`    ${pad(cut(tt(summaryOf(i)) || i.x.t.key, 19), 20)}`, null], [pad(LABEL[i.x.k], 10), STATE_SGR[i.x.k]]] : ticketLead(i, '  '));
  const tail = (i) => (byEpic ? [] : [title(i)]);
  for (const r of slug ? s.list : [...new Set(s.items.map((i) => i.r))]) {
    const mine = (list) => list.filter((i) => i.r === r);
    if (!slug) {
      const n = mine(s.items).length;
      rows.push(segRow(`repo ${r.slug}`, [[`  ${r.name}`, BOLD], [` · ${n} ticket${n === 1 ? '' : 's'}`, DIM]], { kind: 'timeline', slug: r.slug }));
    }
    for (const i of mine(dated)) {
      const sgr = STATE_SGR[i.x.k];
      rows.push(segRow(`${r.slug} ${i.x.t.key}`, [...tlead(i), [' ', null], ...bar(i.e, sgr), [` ${pad(startsCell(i.F, i.x, now), 13)}${pad(shipsCell(i.F, i.x, now), 12)}`, null], ...tail(i)], openTicket(i, epic)));
    }
    // An undated row's reason takes the bar's and the dates' place, so its title lines up when it fits.
    for (const i of mine(undated)) {
      rows.push(segRow(`${r.slug} ${i.x.t.key}`, [...tlead(i), [' ', null], [byEpic ? why(i) : why(i).padEnd(cw + TL_TAIL), STATE_SGR[i.x.k]], ...tail(i)], openTicket(i, epic)));
    }
  }
  const foot = [...(s.notes.length ? ['', ...s.notes] : [])];
  if (!s.items.length) foot.push('', 'Nothing unfinished here.');
  else if (byEpic) {
    foot.push('', `One bar per epic: █ first child starts to last child ships   ░ could run to   n/m children done${width == null ? '' : '   amber: provisional'}`,
      'Enter on an epic shows its tickets. ┆ check-ins at 08:00 and 17:00. Within a week: day and time; beyond, the date.');
  } else {
    foot.push('', `█ starts to ships   ░ could run to (1 run in 5 is later)   ┆ check-ins at 08:00 and 17:00${width == null ? '' : '   colour shows state'}`,
      'Within a week: day and time. Beyond a week: the date.');
  }
  return { head, rows, foot };
}

export const timelineScreen = (repos, slug, opts) => joined(timelineParts(repos, slug, opts));

// The day a ship time falls in: today, tomorrow, each day to 6 days out, then the week by its Monday.
export function shipDay(t, now) {
  const d = calendarDays(t, now);
  if (d <= 0) return `Today · ${dmy(t)}`;
  if (d === 1) return `Tomorrow · ${dmy(t)}`;
  if (d < 7) return dmy(t);
  return `Week of ${dmy(dayAt(t, -((new Date(t).getDay() + 6) % 7)))}`;
}

// Tickets grouped by the day they ship, undated ones last under "No date yet", each with its STARTS,
// SHIPS and title; an undated one says why in place of its dates.
function daysParts(repos, slug, { now = Date.now(), width = null, checkin = false, epic = null } = {}) {
  const s = etaScope(repos, slug, { now, checkin, epic });
  if (!s.list.length) return { head: [nothingToDate], rows: [], foot: [] };
  if (!s.items.length && s.notes.length) return { head: s.notes, rows: [], foot: [] };
  const all = !slug;
  const groups = new Map();
  const add = (g, i) => { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); };
  for (const i of s.items.filter((y) => y.e).sort((a, b) => a.e.likely - b.e.likely)) add(shipDay(i.e.likely, now), i);
  for (const i of s.items.filter((y) => !y.e)) add('No date yet', i);
  const lead = 4 + (all ? 12 : 0) + 20 + 27;
  const tw = width == null ? 60 : Math.max(1, width - lead);
  const tt = titler(s.items.map(summaryOf));
  const head = [...s.head, ''];
  if (s.items.length) head.push(`    ${all ? pad('', 12) : ''}${pad('TICKET', 10)}${pad('STATE', 10)}${pad('STARTS', 13)}${pad('SHIPS', 14)}TITLE`);
  const rows = [];
  for (const [g, list] of groups) {
    rows.push(segRow(`day ${g}`, [[`  ${g}`, BOLD], [` · ${list.length} ticket${list.length === 1 ? '' : 's'}`, DIM]], null));
    for (const i of list) {
      const title = cut(tt(summaryOf(i)), tw);
      const dates = i.e ? [`${pad(startsCell(i.F, i.x, now), 13)}${pad(shipsCell(i.F, i.x, now), 12)}  `, null]
        : [why(i).length <= 25 ? pad(why(i), 27) : `${why(i)}  `, STATE_SGR[i.x.k]];
      rows.push(segRow(`${i.r.slug} ${i.x.t.key}`, [...ticketLead(i, `    ${all ? pad(i.r.name, 12) : ''}`), dates, [title, null]], openTicket(i, epic)));
    }
  }
  const foot = [...(s.notes.length ? ['', ...s.notes] : [])];
  foot.push('', s.items.length ? 'Grouped by ship date: day by day for a week, then week by week.' : 'Nothing unfinished here.');
  return { head, rows, foot };
}

export const daysScreen = (repos, slug, opts) => joined(daysParts(repos, slug, opts));

// The Epics view: each open epic, soonest first, with a bar of its children done, queued and not
// queued yet, its SHIPS and the child that sets it. Enter opens the epic.
const EP_BAR = 16;
function epicsParts(repos, slug, { now = Date.now(), checkin = false } = {}) {
  const s = etaScope(repos, slug, { now, checkin });
  if (!s.list.length) return { head: [nothingToDate], rows: [], foot: [] };
  const all = !slug;
  const list = s.per.filter((p) => p.F).flatMap(({ r, F }) => openEpics(F).map((e) => ({ r, F, e, d: F.E[e.key] })))
    .sort((a, b) => (a.d?.likely ?? Infinity) - (b.d?.likely ?? Infinity));
  const head = [...s.head, ''];
  if (list.length) head.push(`  ${all ? pad('REPO', 12) : ''}${pad('EPIC', 10)}${pad('TITLE', 36)}${pad('CHILDREN', EP_BAR + 7)}  SHIPS`);
  const rows = list.map(({ r, F, e, d }) => {
    const done = Math.round((e.done / e.total) * EP_BAR);
    const queued = e.queued ? Math.min(EP_BAR - done, Math.max(1, Math.round((e.queued / e.total) * EP_BAR))) : 0;
    const date = d ? [[pad(when(d.likely, now), 14), null], [epicNote(e, d), provisional(e) ? STATE_SGR.waiting : DIM]] : [[epicWhy(r, F, e, checkin), STATE_SGR.needs]];
    return segRow(`${r.slug} ${e.key}`, [[`  ${all ? pad(r.name, 12) : ''}${pad(e.key, 10)}${pad(cut(e.summary, 34), 36)}`, null],
      ['■'.repeat(done), STATE_SGR.running], ['■'.repeat(queued), STATE_SGR.waiting], ['□'.repeat(EP_BAR - done - queued), DIM],
      [` ${rpad(`${e.done}/${e.total}`, 6)}  `, null], ...date], { kind: 'epic', slug: r.slug, epic: e.key });
  });
  const foot = [...(s.notes.length ? ['', ...s.notes] : [])];
  if (s.per.some((p) => p.F) && !list.length) foot.push('', 'No queued ticket here belongs to an epic.');
  if (list.length) foot.push('', '■ done  ■ in the queue  □ not queued yet (date is provisional). An epic ships when its last child merges.');
  return { head, rows, foot };
}

// The screens' header note on tickets waiting on the user.
const parkedBadge = (checkin) => (checkin ? 'Parked: dated at the next check-in · c to undo' : 'Parked: no date · c to date them at check-ins');

// ---- screens ---------------------------------------------------------------------------------

// The memory one worker takes at its heaviest: the profile writes it into the cap's reason
// (machine.mjs propose), else the rule the profile is sized by.
function workerGB() {
  const m = /(\d+(?:\.\d+)?) GB per worker/.exec(machineWhy('autopilot-concurrency') ?? '');
  return m ? Number(m[1]) : RULES.workerHeavyGB;
}

// Each pass gates on its own repo's §3b "Spawn gate", so the machine's is the highest of them.
const gateGiB = (repos) => Math.max(...repos.map((r) => spawnGate(repoConfigValue(r.slug, 'spawn-gate')).start), spawnGate(null).start);

const allowedBy = (r) => Math.min(r.workers, r.cap);
const liveAllowed = (repos) => repos.filter((r) => r.live && r.q).reduce((a, r) => a + allowedBy(r), 0);

// How many more workers this machine could start: the smaller of the machine cap less the running
// workers, and the free memory above the spawn gate at `perWorker` GB each.
export function headroom({ running, cap, avail, gate, perWorker }) {
  const byMemory = Math.max(0, Math.floor((avail - gate) / perWorker));
  return cap == null ? byMemory : Math.max(0, Math.min(cap - running, byMemory));
}

// Ready tickets beyond the batch's free slots: they start only as its running workers finish.
const unslotted = (r) => count(r, 'ready') - Math.max(0, r.workers - count(r, 'running'));

// Each screen is built as head lines, selectable rows and foot lines. The plain output joins them;
// the interactive screen draws the rows with a selection and opens a row's `open` view on Enter.
const joined = (s) => [...s.head, ...s.rows.map((x) => x.line), ...s.foot].join('\n');

function overviewParts(repos, { all = false, now = Date.now(), avail = availableGiB(), cap = machineCap(), gate = gateGiB(repos), perWorker = workerGB(), interactive = false, checkin = false } = {}) {
  const list = shownRepos(repos, all);
  const running = repos.reduce((a, r) => a + count(r, 'running'), 0);
  const allowed = liveAllowed(repos);
  const room = headroom({ running, cap, avail, gate, perWorker });
  const at = clock(now);
  const w = Math.max(14, ...repos.map((r) => r.name.length + 2));
  const head = [
    `desk-q · ${at} · workers ${running} running · ${allowed} allowed by live batches · machine ${cap ?? '?'} · ${avail.toFixed(1)} GiB free · room for ${room}${cap == null ? ' (no machine profile: /desk-setup writes one)' : ''}`,
    '',
    `  ${pad('REPO', w)}${pad('LAST PASS', 15)}${rpad('RUN', 4)}${rpad('READY', 7)}${rpad('WAIT', 6)}${rpad('STUCK', 7)}${rpad('NEEDS YOU', 11)}${rpad('FAILED', 8)}${rpad('DONE', 6)}  ${pad('QUEUE DONE', 12)}  WORKERS`,
  ];
  const rows = [], foot = [];
  const row = (r, line) => rows.push({ id: r.slug, line, open: { kind: 'repo', slug: r.slug } });
  let you = 0, stuck = 0;
  for (const r of list) {
    if (r.error) { row(r, `  ${pad(r.name, w)}queue unreadable: ${r.error}`); continue; }
    you += count(r, 'needs'); stuck += count(r, 'stuck');
    const last = r.live ? `live ${ago(now - r.last).replace(' ago', '')}` : ago(r.last == null ? null : now - r.last);
    // Each state count in its state's colour, a zero plain.
    const n = (k, cw, sgr = STATE_SGR[k]) => { const c = count(r, k); return [rpad(c, cw), c ? sgr : null]; };
    rows.push(segRow(r.slug, [[`  ${pad(r.name, w)}${pad(last, 15)}`, null], n('running', 4), n(['ready', 'queued'], 7, STATE_SGR.ready), n('waiting', 6), n('stuck', 7), n('needs', 11), n('failed', 8),
      [`${rpad(r.done, 6)}  ${pad(queueDone(r, now, checkin), 12)}  ${r.workers} (cap ${r.cap})${unslotted(r) > 0 ? ` · ${unslotted(r)} ready with no free slot` : ''}`, null]], { kind: 'repo', slug: r.slug }));
  }
  const none = repos.filter((r) => !hasBatch(r));
  if (all) for (const r of none) row(r, `  ${pad(r.name, w)}${pad('no batch', 78)}  cap ${r.cap}`);
  if (!list.length && !(all && none.length)) foot.push('  No batch is live, and no quiet batch needs you.');
  foot.push('', `${you} need you, ${stuck} stuck.`);
  if (!all && none.length) foot.push(`${none.length} more set up with no batch: ${none.map((r) => r.name).join(', ')}. ${interactive ? 'Press a to list them.' : 'desk-q --all lists them.'}`);
  const seen = new Set();
  for (const r of repos) {
    for (const c of portClashes(r.claim, repos.map((x) => x.claim))) {
      const o = repos.find((x) => x.slug === c.slug);
      const pair = [r.name, o.name].sort();
      if (seen.has(pair.join())) continue;
      seen.add(pair.join());
      foot.push(`ports overlap: ${pair.join(' + ')} share ${Math.max(r.claim.port, c.port)}–${Math.min(r.claim.last, c.last)}. Two batches there at once can get the same worker port.`);
    }
  }
  return { head, rows, foot };
}

export const overview = (repos, opts) => joined(overviewParts(repos, opts));

const clock = (t) => new Date(t).toTimeString().slice(0, 5);

// When the batch's passes run, for a header: the next one while live, else that they have stopped,
// what that means for its workers, and how to start them again.
function passLines(r, now) {
  if (r.live) {
    const next = r.next == null ? '' : r.next > now ? ` · next pass ${clock(r.next)}` : ` · next pass due ${clock(r.next)}`;
    return [`orchestrator live, last pass ${ago(now - r.last)}${next}`];
  }
  const resume = r.q?.supervised === true ? `check the supervisor: node ~/.claude/desk/bin/supervisor.mjs status, in ${r.name}`
    : `run /desk-autopilot in ${r.name} and ask it to pick the batch back up`;
  return [
    r.last == null ? 'no pass yet' : `passes stopped: last pass ${clock(r.last)} (${ago(now - r.last)})${r.next != null ? `, next was due ${clock(r.next)}` : ''}`,
    `Running workers carry on, but nothing new starts and stages are not updated. To resume passes, ${resume}.`,
  ];
}

// Why a ready ticket has not started: its batch's worker slots, a running ticket it collides with,
// or the pass that will start it.
function readyWhy(r, t) {
  if (r.workers === 0) return 'workers set to 0';
  const busy = count(r, 'running');
  if (busy >= r.workers) return `waits for a worker (${busy} of ${r.workers} busy)`;
  const clash = String(t.collides_with ?? '').split('|').filter((c) => r.q.tickets?.[c]?.state === 'running');
  if (clash.length) return `waits for ${clash.join(', ')} to finish`;
  return r.live ? 'starts at the next pass' : 'starts when passes resume';
}

function detail(r, x) {
  const { t, k } = x;
  // A stage is the last pass's reading: the worker may be further on.
  if (k === 'running') return `stage ${t.stage ?? '?'} ${r.last == null ? 'as of an unknown pass' : `as of ${clock(r.last)}`}`;
  if (k === 'ready') return readyWhy(r, t);
  if (k === 'waiting' || k === 'stuck') return `behind ${unmergedBlockers(r.q, t).join(', ') || 'PRs of done tickets'}`;
  if (k === 'needs') return t.state === 'parked' ? (t.park?.question ?? 'parked') : `${t.open_questions} triage question(s) open`;
  if (k === 'failed') return t.park?.question ?? '';
  if (k === 'queued') return 'waiting for triage';
  return '';
}

// DETAIL's width, wide enough for "waits for a worker (12 of 12 busy)"; the columns before TITLE on a ticket row.
const DETAIL_W = 36;
const ROW_LEAD = 92;

// `width` is the terminal's: titles take what the row has left, rather than a fixed 60. `epic` keeps
// to that epic's tickets, each keeping its place in the whole queue.
function repoParts(r, { now = Date.now(), width = null, checkin = false, epic = null } = {}) {
  const none = { rows: [], foot: [] };
  if (r.error) return { head: [`${r.name} · queue unreadable: ${r.error}`], ...none };
  if (!r.q) return { head: [`${r.name} · set up, no autopilot batch yet · cap ${r.cap} · ports ${r.claim.port}–${r.claim.last}`, '', 'Nothing to show until a batch starts. Run /desk-autopilot in that repo to start one.'], ...none };
  const [pass, ...stopped] = passLines(r, now);
  const head = [
    `${r.name} · batch ${r.q.batch ?? '-'} · ${pass}`,
    ...stopped,
    `workers ${count(r, 'running')} running of ${r.workers} (cap ${r.cap}) · ${r.done} done, not shown`,
    '',
    `  ${rpad('#', 4)}  ${pad('TICKET', 10)}${pad('STATE', 11)}${pad('DETAIL', DETAIL_W)}${pad('STARTS', 13)}${pad('SHIPS', 14)}TITLE`,
  ];
  const tw = width == null ? 60 : Math.max(1, width - ROW_LEAD);
  const F = forecastOf(r, { now, checkin });
  const ep = epic ? F.epics[epic] : null;
  if (ep) head.splice(1, 0, `${ep.key} · ${ep.summary} · ${ep.done} of ${ep.total} children done`);
  const list = epic ? r.rows.filter((x) => F.of[x.t.key] === epic) : r.rows;
  const summary = (x) => summaryOf({ r, x });
  const tt = titler(list.map(summary));
  const rows = list.map((x) => segRow(x.t.key, [
    [`  ${rpad(x.pos == null ? '-' : `${x.t.placed ? '*' : ''}${x.pos}`, 4)}  ${pad(x.t.key, 10)}`, null], [pad(LABEL[x.k], 11), STATE_SGR[x.k]],
    [`${pad(cut(detail(r, x), DETAIL_W - 2), DETAIL_W)}${pad(startsCell(F, x, now), 13)}${pad(shipsCell(F, x, now), 14)}${cut(tt(summary(x)), tw)}`, null],
  ], { kind: 'ticket', slug: r.slug, key: x.t.key, ...(epic ? { epic } : {}) }));
  const foot = !list.length ? ['  No unfinished tickets.']
    : list.some((x) => x.t.placed) ? ['', '* placed by you: a release or requeue leaves it where it is'] : [];
  return { head, rows, foot };
}

export const repoScreen = (r, opts) => joined(repoParts(r, opts));

const logPath =(r, key) => join(r.stateDir, 'logs', `${key}.log`);

// `jiraUrl` adds the Jira line the interactive screen opens with o.
function ticketParts(r, key, { width = null, jiraUrl = null, now = Date.now(), checkin = false } = {}) {
  const t = r.q.tickets[key];
  const k = shownState(r.q, t);
  const row = r.rows.find((x) => x.t.key === key);
  const tr = triageOf(r.stateDir, key) ?? {};
  const pos = r.rows.find((x) => x.t.key === key)?.pos;
  const lane = t.lane && t.lane !== '?' ? t.lane : tr.lane ?? '?';
  const ww = width == null ? 96 : Math.max(20, Math.min(96, width - 2));
  const head = [
    `${key}  ${LABEL[k]}  ${[t.type ?? tr.type, `size ${tr.size ?? '?'}`, `lane ${lane}`, pos != null ? `position ${pos} of ${r.places}${t.placed ? ' (placed by you)' : ''}` : null].filter(Boolean).join(' · ')}`,
    '',
    ...(tr.summary ? wrap(tr.summary, ww) : ['(no triage record: title unknown)']),
    '',
  ];
  const rows = [], out = [];
  if (k === 'running') head.push(`A worker is on it, at stage ${t.stage ?? '?'}.`, '');
  if (row) head.push(...etaLines(r, forecastOf(r, { now, checkin }), row, now));
  if (k === 'waiting' || k === 'stuck') {
    const open = unmergedBlockers(r.q, t);
    head.push(!open.length ? 'Every blocker is done: it starts once the merge driver sees their PRs merged.'
      : k === 'waiting' ? 'Starts when the last of these merges:' : 'Stuck. At least one of these will never merge by itself:');
    for (const b of open) {
      const bt = r.q.tickets[b];
      const line = `  ${pad(b, 10)}${bt ? `${pad(LABEL[shownState(r.q, bt)], 11)}${cut(triageOf(r.stateDir, b)?.summary ?? '', 70)}` : 'not in this queue'}`.trimEnd();
      rows.push({ id: b, line, open: bt ? { kind: 'ticket', slug: r.slug, key: b } : null });
    }
    out.push('');
  }
  if (t.park?.question) out.push(`Parked: ${t.park.question}`);
  if (k === 'needs') {
    out.push(/^lane [CD]\b/.test(t.park?.question ?? '') ? `Lane C or D: open an interactive /desk-ticket ${key} session.`
      : `Answer, in ${r.name}: node ~/.claude/desk/bin/answer.mjs ${key} "…", then the orchestrator decides whether to requeue it.`);
  }
  if (k === 'stuck') out.push('Unblock the blocker first, or have the orchestrator drop this hold (orchestrator-recovery.md).');
  if (t.park?.question || ['needs', 'stuck'].includes(k)) out.push('');
  if (tr.lane_reason) { out.push(`Why lane ${lane}:`); for (const l of wrap(tr.lane_reason, ww)) out.push(`  ${l}`); out.push(''); }
  const files = tr.files_in_scope ?? [];
  if (files.length) { out.push(`Files in scope (${files.length}):`); for (const f of files) out.push(`  ${f}`); out.push(''); }
  if (t.collides_with) out.push(`Never runs at the same time as: ${String(t.collides_with).split('|').join(', ')}`);
  const branch = t.branch ?? tr.branch;
  if (branch) out.push(`Branch: ${branch}`);
  out.push(`Log: ${logPath(r, key)}${width == null ? '' : '  (l shows the last 40 lines)'}`);
  if (jiraUrl) out.push(`Jira: ${jiraUrl}  (o opens it)`);
  return { head, rows, foot: out };
}

export const ticketScreen = (r, key, opts) => joined(ticketParts(r, key, opts));

// ---- the command -------------------------------------------------------------------------------

class Usage extends Error {}

// Exact name first, then a unique prefix of the short name; owner/name and the slug match too.
export function resolveRepo(repos, word) {
  const w = word.toLowerCase();
  const exact = repos.filter((r) => [r.name, r.slug, r.slug.replace('__', '/')].some((n) => n.toLowerCase() === w));
  if (exact.length === 1) return exact[0];
  const hits = repos.filter((r) => r.name.toLowerCase().startsWith(w));
  if (hits.length === 1) return hits[0];
  if (hits.length) throw new Usage(`"${word}" matches ${hits.map((r) => r.name).join(' and ')}. Type more of the name.`);
  throw new Usage(`No repo "${word}". Set up here: ${repos.map((r) => r.name).join(', ')}.`);
}

const MOVES = ['up', 'down', 'top', 'bottom', 'move'];
const SHIPS = ['ships', 'when'];
const VERBS = ['show', ...MOVES, 'workers', 'ships', 'days'];
const isWrite = (v) => v.kind === 'move' || v.kind === 'workers';
// The view a ships or days word names.
const etaView = (word, slug) => ({ kind: word.toLowerCase() === 'days' ? 'days' : 'timeline', slug });

// What the words name: a view, or a move or workers change. The one-shot command line and the
// screen's ":" prompt read the same words.
function target(repos, words) {
  const [repoWord, verb, keyWord, ...extra] = words.filter((a) => !a.startsWith('--'));
  if (!repoWord) return { kind: 'overview', all: words.includes('--all') };
  // `ships [<repo>]` and `days [<repo>]` read before a repo name, and `<repo> ships` after one.
  if ([...SHIPS, 'days'].includes(repoWord.toLowerCase())) {
    if (keyWord) throw new Usage(`Unknown command "${words.filter((a) => !a.startsWith('--')).join(' ')}". Try desk-q ${repoWord.toLowerCase()} [<repo>].`);
    return etaView(repoWord, verb ? resolveRepo(repos, verb).slug : null);
  }
  const r = resolveRepo(repos, repoWord);
  if (!verb) return { kind: 'repo', slug: r.slug };
  const unknown = () => new Usage(`Unknown command "${[verb, keyWord, ...extra].filter(Boolean).join(' ')}". Verbs: ${VERBS.join(', ')}.`);
  if ([...SHIPS, 'days'].includes(verb)) { if (keyWord) throw unknown(); return etaView(verb, r.slug); }
  if (!VERBS.includes(verb)) throw unknown();
  if (r.error) throw new Usage(`${r.name}: queue unreadable: ${r.error}`);
  if (!r.q) throw new Usage(`${r.name} has no batch yet.`);
  if (verb === 'workers') {
    if (keyWord == null) throw new Usage(`How many? desk-q ${r.name} workers <n>.`);
    if (extra.length) throw unknown();
    return { kind: 'workers', slug: r.slug, n: keyWord };
  }
  if (!keyWord) throw new Usage(`Which ticket? desk-q ${r.name} ${verb} <KEY>${verb === 'move' ? ' <n>' : ''}.`);
  const key = [keyWord, keyWord.toUpperCase()].find((k) => r.q.tickets?.[k]);
  if (!key) throw new Usage(`${keyWord} isn't in ${r.name}'s queue.`);
  if (verb === 'move') {
    if (extra.length !== 1) throw new Usage(`Which position? desk-q ${r.name} move ${key} <n>.`);
    return { kind: 'move', slug: r.slug, key, verb, to: extra[0] };
  }
  if (extra.length) throw unknown();
  return verb === 'show' ? { kind: 'ticket', slug: r.slug, key } : { kind: 'move', slug: r.slug, key, verb };
}

// ---- changes -----------------------------------------------------------------------------------

const QUEUE_MJS = join(dirname(fileURLToPath(import.meta.url)), 'queue.mjs');

// Every change is a queue.mjs command, which takes the queue's lock. Its queue and state directory
// are the named repo's, passed explicitly: left to itself, queue.mjs picks the repo it is run in.
function queueCmd(r, args) {
  try {
    execFileSync(process.execPath, [QUEUE_MJS, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DESK_QUEUE: r.queuePath, DESK_AUTOPILOT_STATE: r.stateDir } });
  } catch (e) {
    throw new Usage(String(e.stderr ?? '').trim().replace(/^queue: /, '') || describeCrash(e));
  }
}

// Positions are queue.mjs's (loadRepos), so a place here is the place passed on.
function moveTicket(r, key, verb, to) {
  const x = r.rows.find((y) => y.t.key === key);
  if (!x) throw new Usage(`${key} is done: only unfinished tickets have a place in the spawn order.`);
  const i = x.pos, last = r.places;
  if (x.k === 'running') throw new Usage(`${key} is running, so its position no longer matters. Nothing moved.`);
  if (x.k === 'failed') throw new Usage(`${key} failed, so it has no place in the spawn order until it is requeued. Nothing moved.`);
  let n;
  if (verb === 'move') {
    if (!/^\d+$/.test(to) || Number(to) < 1 || Number(to) > last) throw new Usage(`Position ${to} is out of range: give 1 to ${last}. Nothing moved.`);
    n = Number(to);
  } else n = { up: i - 1, down: i + 1, top: 1, bottom: last }[verb];
  if (n < 1 || n > last || n === i) throw new Usage(`${key} is already at position ${i}. Nothing moved.`);
  queueCmd(r, ['move', key, String(n)]);
  const why = x.k === 'waiting' ? ` It still waits on ${unmergedBlockers(r.q, x.t).join(', ') || 'its blockers'}, then starts from here.`
    : x.k === 'stuck' ? ` Still stuck behind ${unmergedBlockers(r.q, x.t).join(', ')}: moving it does not unblock it.`
      : x.k === 'needs' ? ' It still needs you first.' : x.k === 'queued' ? ' It still waits for triage.' : '';
  return `${key} → position ${n} of ${last}, placed by you.${why}`;
}

// Above the repo's cap is refused, with what raising the cap would take; above the machine's total
// goes ahead with a warning, since the memory gate still holds back spawns.
function setWorkers(repos, r, word) {
  const n = /^\d+$/.test(word) ? Number(word) : NaN;
  if (!Number.isInteger(n)) throw new Usage(`Workers must be a whole number from 0 to ${r.cap}. Nothing changed.`);
  const total = liveAllowed(repos.filter((x) => x.slug !== r.slug)) + n;
  const cap = machineCap();
  if (n > r.cap) {
    const block = { slug: r.slug, port: r.claim.port, last: r.claim.port + n };
    const clash = portClashes(block, repos.map((x) => x.claim)).map((c) => `${repos.find((x) => x.slug === c.slug).name} (${c.port}–${c.last})`);
    throw new Usage(`${r.name}'s cap is ${r.cap}, so ${n} workers is refused: nothing changed. `
      + `A cap of ${n} is an edit to §3b "Autopilot worker concurrency" in ${join(deskConfigRoot(), 'repos', r.slug, 'config.md')}. `
      + `It would hold ports ${block.port} to ${block.last}, ${clash.length ? `overlapping ${clash.join(' and ')}` : 'clear of every other repo'}, `
      + `and live batches would then allow ${total} against this machine's ${cap ?? '? (no machine profile)'}.`);
  }
  const was = r.workers;
  queueCmd(r, ['set-batch', `concurrency=${n}`, 'concurrency_by=user']);
  return `${r.name}: workers ${was} → ${n} (cap ${r.cap}), set by you. The next pass uses it.`
    + (n === 0 ? ' No new workers start, and running ones finish.' : '')
    + (cap != null && total > cap ? ` Live batches now allow ${total}, over this machine's ${cap}: allowed, and the memory gate holds new workers below ${gateGiB(repos)} GiB free.` : '');
}

// One confirmation line, or a Usage refusal that says what to do instead.
function apply(repos, v) {
  const r = repos.find((x) => x.slug === v.slug);
  return v.kind === 'workers' ? setWorkers(repos, r, v.n) : moveTicket(r, v.key, v.verb, v.to);
}

function checkFlags(argv) {
  const unknown = argv.filter((a) => a.startsWith('--') && !['--plain', '--all', '--help'].includes(a));
  if (unknown.length) throw new Usage(`Unknown option ${unknown.join(' ')}. Options: --plain, --all.`);
}

function loadOrRefuse(now) {
  const repos = loadRepos(now);
  if (!repos.length) throw new Usage('No repo is set up for desk on this machine. Run /desk-setup in a repo first.');
  return repos;
}

export function run(argv, { now = Date.now() } = {}) {
  if (argv.includes('--help')) return 'usage: desk-q [--plain] [--all] | desk-q [--plain] <repo> [show <KEY>] | desk-q ships|days [<repo>]\n'
    + '       desk-q <repo> up|down|top|bottom <KEY> | desk-q <repo> move <KEY> <n> | desk-q <repo> workers <n>';
  checkFlags(argv);
  const repos = loadOrRefuse(now);
  const v = target(repos, argv);
  if (v.kind === 'overview') return overview(repos, { all: v.all, now });
  // Piped, the Timeline is drawn as plain text; --plain asks for the one-line-per-ticket list instead.
  if (v.kind === 'timeline') return argv.includes('--plain') ? shipsScreen(repos, v.slug, { now }) : timelineScreen(repos, v.slug, { now });
  if (v.kind === 'days') return daysScreen(repos, v.slug, { now });
  if (isWrite(v)) {
    const said = apply(repos, v);
    return `${said}\n\n${repoScreen(loadOrRefuse(now).find((x) => x.slug === v.slug), { now })}`;
  }
  const r = repos.find((x) => x.slug === v.slug);
  return v.kind === 'repo' ? repoScreen(r, { now }) : ticketScreen(r, v.key, { now });
}

// ---- the interactive screen --------------------------------------------------------------------

export const REFRESH_MS = 2000;
const LOG_LINES = 40;
const MOVE_KEYS = 'shift+↑↓ move · t top · b bottom · + − workers';
const ESC = '\x1b[';
// Mouse reporting in SGR form (1000 + 1006), so a click on the breadcrumb, a tab or a row arrives
// as ESC [ < button ; column ; row M.
const ENTER_SCREEN = `${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h`;
export const LEAVE_SCREEN = `${ESC}?1006l${ESC}?1000l${ESC}?25h${ESC}?1049l`;
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const PARTIAL_MS = 30;
const REVERSE = '7';
// The views every place but a ticket has, in the order Tab and the number keys take them. An epic
// has every one but Epics.
export const VIEWS = [['queue', 'Queue'], ['timeline', 'Timeline'], ['days', 'By day'], ['epics', 'Epics']];
const VIEW_KEYS = 'tab or 1–4 view';
export const REORDER_HERE = 'Reorder on the Queue view (press 1). The dates follow.';
// An epic's Queue hides the tickets a move steps past, so the order is set on the repo's.
export const REORDER_IN_REPO = "Reorder on the repo's Queue (esc, then 1). The dates follow.";
export const NO_EPICS_HERE = "An epic has no Epics view: you're already in one.";

function jiraUrlFor(slug, key) {
  const site = repoConfigValue(slug, 'jira-site');
  if (!site || /^none$/i.test(site)) return null;
  return `https://${site.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/browse/${key}`;
}

function systemOpener(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const p = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
  p.on('error', () => {});
  p.unref();
}

// Log text can carry a worker's own escape codes; only printable text reaches the screen.
const printable = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f]/g, '');

// A row cut to `w` columns as `cut` would, `›` in its first column when selected, then each coloured
// run wrapped in its SGR code. Each code is undone on its own (22 or 39), so a selected row's
// reverse video holds across the runs. NO_COLOR drops the colours and keeps bold, dim and reverse.
function paint(x, w, selected) {
  const plain = !!process.env.NO_COLOR;
  let segs = (x.segs ?? [[x.line, null]]).map(([s, k]) => [s, k]);
  if (selected) segs[0][0] = `›${segs[0][0].slice(1)}`;
  if (x.line.length > w) {
    const kept = [];
    let room = w - 1;
    for (const [s, k] of segs) { if (room <= 0) break; kept.push([s.slice(0, room), k]); room -= s.length; }
    segs = [...kept, ['…', null]];
  }
  return segs.map(([s, k]) => (k && s && !(plain && ![BOLD, DIM, REVERSE].includes(k)) ? `${ESC}${k}m${s}${ESC}${k === BOLD || k === DIM ? '22' : k === REVERSE ? '27' : '39'}m` : s)).join('');
}

// Labels joined by `sep`, each with the columns it covers (from, up to end), so a click's column
// finds its label.
function spans(parts, sep) {
  let at = 0;
  return parts.map((p, i) => { const from = at + (i ? sep.length : 0); at = from + p.label.length; return { ...p, from, end: at }; });
}

// A keys line too long for the terminal breaks between keys rather than losing the last ones.
function wrapKeys(s, w) {
  const out = [];
  for (const k of s.split(' · ')) { if (out.length && `${out.at(-1)} · ${k}`.length <= w) out[out.length - 1] += ` · ${k}`; else out.push(k); }
  return out;
}

// A Timeline or By day view names its place by repo, or every repo, as the screen does.
const placeOf = (v) => (v.kind === 'timeline' || v.kind === 'days'
  ? { place: v.slug ? { kind: 'repo', slug: v.slug } : { kind: 'overview', all: false }, tab: v.kind }
  : { place: v, tab: null });

// The full-screen view is a place (every repo, a repo, an epic, a ticket) and, for every place but a
// ticket, a view of it: Queue, Timeline, By day or Epics. Tab, 1–4, w and a click on the tab line change the view
// and keep the place; Enter, Esc and a click on the breadcrumb change the place and keep the view.
// ↑↓ select, : takes a command, q quits. Rereads the queues every REFRESH_MS, keeping the selection
// on the same repo or ticket.
export function interactive({
  input = process.stdin, output = process.stdout, start = { kind: 'overview', all: false },
  opener = systemOpener, exit = (c) => process.exit(c), refreshMs = REFRESH_MS, clock = Date.now,
} = {}) {
  let repos = loadOrRefuse(clock());
  // On a screen too tall to fit, `scroll` is its first line shown when it has no rows to select,
  // and how far past the selection it shows when it has.
  // `tab`: the view, one of VIEWS, kept across every change of place.
  // `checkin`: tickets waiting on the user are dated as if answered at the next check-in (c).
  // `zoom`: the Timeline's scale, z cycling it; back to auto whenever the place changes.
  // `layout`: where the last draw put the breadcrumb, the tabs and the rows, for a click to find them.
  let view = null, tab = 'queue', sel = 0, selId = null, scroll = null, msg = '', cmd = null, screen = null, done = false, timer = null, checkin = false, zoom = 'auto', layout = null;
  const stack = [];
  const width = () => Math.max(20, output.columns || 80);
  const height = () => Math.max(5, output.rows || 24);
  const repoOf = (slug) => repos.find((r) => r.slug === slug);
  const hasTabs = () => ['overview', 'repo', 'epic'].includes(view.kind);
  const tabOk = (id) => !(view.kind === 'epic' && id === 'epics');
  const epicFacts = () => { const r = repoOf(view.slug); return r?.q ? forecastOf(r, { now: clock(), checkin }) : null; };
  // The parked note is shown while any ticket in view waits on the user, or c is on.
  const badge = (rs) => (checkin || rs.some((r) => count(r, 'needs') > 0) ? parkedBadge(checkin) : '');

  // The breadcrumb's parts, each with the place a click on it goes to; the last is where you are.
  function crumbParts() {
    const r = view.slug ? repoOf(view.slug) : null;
    const parts = [{ label: 'desk-q', to: { kind: 'overview', all: false } }];
    if (view.slug) parts.push({ label: r?.name ?? view.slug, to: { kind: 'repo', slug: view.slug } });
    if (view.epic) parts.push({ label: cut(epicShort(epicFacts()?.epics?.[view.epic] ?? { key: view.epic }), 40), to: { kind: 'epic', slug: view.slug, epic: view.epic } });
    if (view.key) parts.push({ label: view.key, to: { kind: 'ticket', slug: view.slug, key: view.key, ...(view.epic ? { epic: view.epic } : {}) } });
    if (view.kind === 'log') parts.push({ label: 'log', to: null });
    return spans(parts, ' › ');
  }

  // "1 Queue  2 Timeline  3 By day  4 Epics", the view shown in reverse video and one this place
  // lacks dimmed.
  const tabParts = () => spans(VIEWS.map(([id, label], i) => ({ label: `${i + 1} ${label}`, id })), '  ');

  function build() {
    const now = clock();
    const w = width();
    const r = view.slug ? repoOf(view.slug) : null;
    const esc = view.kind === 'overview' ? '' : 'esc back · ';
    const cmdKeys = `: command · ${esc}q quit`;
    if (view.slug && !r) return { head: ['That repo is no longer set up here.'], rows: [], foot: [], keys: cmdKeys };
    if (!tabOk(tab)) tab = 'timeline';
    if (view.kind === 'epic' && !epicIn(r, epicFacts(), view.epic)) return { head: [`${view.epic} has no unfinished tickets in ${r.name}'s queue.`], rows: [], foot: [], keys: cmdKeys };
    if (tab !== 'queue' && hasTabs()) {
      const tl = tab === 'timeline';
      const opts = { now, width: w, checkin, zoom, epic: view.epic ?? null };
      const parts = tl ? timelineParts : tab === 'days' ? daysParts : epicsParts;
      return { badge: badge(r ? [r] : repos), ...parts(repos, view.slug ?? null, opts),
        keys: `↑↓ select · enter open · ${VIEW_KEYS} · ${tl ? 'z scale · ' : ''}c parked dates · ${cmdKeys}` };
    }
    if (view.kind === 'overview') {
      return { badge: badge(repos), ...overviewParts(repos, { all: view.all, now, interactive: true, checkin }),
        keys: `↑↓ select · enter open · ${VIEW_KEYS} · a ${view.all ? 'hide repos with no batch' : 'all repos'} · c parked dates · ${cmdKeys}` };
    }
    if (view.kind === 'repo') return { badge: badge([r]), ...repoParts(r, { now, width: w, checkin }), keys: `↑↓ select · enter open · ${VIEW_KEYS} · ${r.q ? `${MOVE_KEYS} · c parked dates · ` : ''}${cmdKeys}` };
    if (view.kind === 'epic') return { badge: badge([r]), ...repoParts(r, { now, width: w, checkin, epic: view.epic }), keys: `↑↓ select · enter open · ${VIEW_KEYS} · c parked dates · ${cmdKeys}` };
    if (!r.q?.tickets?.[view.key]) return { head: [`${view.key} is no longer in ${r.name}'s queue.`], rows: [], foot: [], keys: cmdKeys };
    if (view.kind === 'log') {
      const p = logPath(r, view.key);
      const lines = readFileSync(p, 'utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      const last = lines.slice(-LOG_LINES).map(printable);
      return { head: [`Last ${last.length} lines of ${p}`, ''], rows: [], foot: last, keys: '↑↓ scroll · esc back · q quit', bottom: true };
    }
    const jira = jiraUrlFor(r.slug, view.key);
    const s = ticketParts(r, view.key, { width: w, jiraUrl: jira, now, checkin });
    const keys = `${s.rows.length ? '↑↓ select a blocker · enter open it · ' : ''}${MOVE_KEYS} · l log · ${jira ? 'o Jira · ' : ''}c parked dates · ${cmdKeys}`;
    return { badge: badge([r]), ...s, keys };
  }

  function draw() {
    if (done) return;
    try { screen = build(); } catch (e) { screen = { head: [`Could not draw this screen: ${describeCrash(e)}`], rows: [], foot: [], keys: 'esc back · q quit' }; }
    const { rows } = screen;
    if (selId != null) { const i = rows.findIndex((x) => x.id === selId); if (i >= 0) sel = i; }
    sel = Math.max(0, Math.min(sel, rows.length - 1));
    selId = rows[sel]?.id ?? null;
    const w = width(), h = height();
    const fit = (l) => cut(l, w);
    // The breadcrumb and the tab line stay at the top while the rest scrolls. A ticket has no tab
    // line, so its parked note follows the breadcrumb.
    const crumbs = crumbParts().map((p) => p.label).join(' › ');
    const pinned = [];
    if (hasTabs()) {
      const segs = tabParts().flatMap((p, i) => [...(i ? [['  ', null]] : []), [p.label, p.id === tab ? REVERSE : tabOk(p.id) ? null : DIM]]);
      if (screen.badge) segs.push([`    ${screen.badge}`, null]);
      pinned.push(fit(crumbs), paint({ segs, line: segs.map((s) => s[0]).join('') }, w, false));
    } else pinned.push(fit(screen.badge ? `${crumbs}    ${screen.badge}` : crumbs));
    const body = ['', ...screen.head.map(fit),
      ...rows.map((x, i) => (i === sel ? `${ESC}7m${paint(x, w, true)}${ESC}27m` : paint(x, w, false))), ...screen.foot.map(fit)];
    // A message can be longer than the line (a refused raise says what raising the cap takes).
    const status = [...wrap(msg, w), ...(cmd != null ? [`:${cmd}`] : wrapKeys(screen.keys, w))].filter(Boolean).map(fit);
    const room = Math.max(1, h - status.length - pinned.length);
    const first = 1 + screen.head.length;
    let top = 0;
    if (body.length > room) {
      const max = body.length - room;
      const clamp = (n) => Math.max(0, Math.min(max, n));
      if (rows.length) {
        // Centred on the selection; `scroll` is how far ↓ on the last row has read on past it.
        const base = clamp(first + sel - Math.floor(room / 2));
        top = clamp(base + (scroll ?? 0));
        scroll = top - base;
      } else top = scroll = clamp(scroll ?? (screen.bottom ? max : 0));
    } else if (rows.length) scroll = 0;
    const shown = body.slice(top, top + room);
    while (shown.length < room) shown.push('');
    layout = { pinned: pinned.length, top, room, first, rows: rows.length };
    output.write(`${ESC}H${[...pinned, ...shown, ...status].map((l) => `${l}${ESC}K`).join('\r\n')}${ESC}J`);
  }

  // A new place pushes the one you were on, so Esc comes back to it with its selection; the view
  // stays whatever it is. A Timeline or By day row opening a repo opens that repo's same view, and an
  // Epics row opens its epic's Timeline.
  function go(v) {
    const p = placeOf(v);
    stack.push({ view, sel, selId, tab });
    view = p.place; if (p.tab) tab = p.tab;
    if (!tabOk(tab)) tab = 'timeline';
    sel = 0; selId = null; scroll = null; msg = ''; zoom = 'auto';
  }
  // The selection comes back only to the view it was made on: another view's rows are other rows.
  function back() {
    const p = stack.pop();
    if (p) { view = p.view; if (p.tab === tab) ({ sel, selId } = p); else { sel = 0; selId = null; } }
    scroll = null; msg = ''; zoom = 'auto';
  }
  // A place reached directly (the command line, :, the breadcrumb) gets the places above it to Esc to.
  function goPlace(v) {
    const p = placeOf(v);
    if (p.tab) tab = p.tab;
    stack.length = 0;
    const up = (u) => stack.push({ view: u, sel: 0, selId: null, tab });
    const { kind, slug, epic, key } = p.place;
    if (kind !== 'overview') up({ kind: 'overview', all: false });
    if (['epic', 'ticket', 'log'].includes(kind)) up({ kind: 'repo', slug });
    if (epic && kind !== 'epic') up({ kind: 'epic', slug, epic });
    if (kind === 'log') up({ kind: 'ticket', slug, key, ...(epic ? { epic } : {}) });
    view = p.place; sel = 0; selId = null; scroll = null; msg = ''; zoom = 'auto';
    if (!tabOk(tab)) tab = 'timeline';
  }
  // A view this place lacks leaves the view as it is and says why.
  function setTab(id) {
    if (!tabOk(id)) { msg = NO_EPICS_HERE; return; }
    tab = id; sel = 0; selId = null; scroll = null; msg = '';
  }

  // A left click on the breadcrumb goes to that place, on the tab line to that view, on a row
  // selects and opens it. The wheel moves the selection as the arrows do.
  function onMouse(b, x, y) {
    if (done || !layout || cmd != null) return;
    if (b === 64 || b === 65) return onKey(undefined, { name: b === 64 ? 'up' : 'down' });
    if ((b & ~(4 | 8 | 16)) !== 0) return;
    const col = x - 1, line = y - 1;
    const hit = (parts) => parts.find((p) => col >= p.from && col < p.end);
    if (line === 0) {
      const parts = crumbParts(), p = hit(parts);
      if (!p || p === parts.at(-1) || !p.to) return;
      goPlace(p.to);
    } else if (line === 1 && hasTabs()) {
      const p = hit(tabParts());
      if (!p) return;
      setTab(p.id);
    } else {
      const i = line - layout.pinned + layout.top - layout.first;
      if (line < layout.pinned || line >= layout.pinned + layout.room || i < 0 || i >= layout.rows) return;
      sel = i; selId = screen.rows[i]?.id ?? null;
      const o = screen.rows[i]?.open;
      if (o) go(o);
    }
    draw();
  }

  // Mouse reports are taken out of the input before readline reads it for keys, which would
  // otherwise split one into stray keypresses. A read ending in what may be the start of one (ESC,
  // ESC [, ESC [ < …) waits for the next read; with none within PARTIAL_MS it goes on to readline
  // as keys, so a lone Esc still arrives.
  const keys = new PassThrough();
  let partial = '', flush = null;
  function onData(chunk) {
    clearTimeout(flush);
    let s = partial + String(chunk);
    const cutAt = s.search(/\x1b(\[(<[\d;]*)?)?$/);
    partial = cutAt >= 0 ? s.slice(cutAt) : '';
    if (cutAt >= 0) s = s.slice(0, cutAt);
    const clicks = [];
    s = s.replace(MOUSE, (_, b, x, y, m) => { if (m === 'M') clicks.push([Number(b), Number(x), Number(y)]); return ''; });
    if (s) keys.write(s);
    for (const c of clicks) onMouse(...c);
    if (partial) flush = setTimeout(() => { const p = partial; partial = ''; if (!done) keys.write(p); }, PARTIAL_MS);
  }

  function finish(code) {
    if (done) return;
    done = true;
    clearInterval(timer);
    clearTimeout(flush);
    input.removeListener('data', onData);
    keys.removeListener('keypress', onKey);
    output.removeListener?.('resize', draw);
    if (input.isTTY) input.setRawMode(false);
    input.pause?.();
    output.write(LEAVE_SCREEN);
    exit(code);
  }

  // A change, then the queues reread so the screen shows it; the message stays until the next view.
  function act(v) {
    try { msg = apply(repos, v); } catch (e) { msg = e instanceof Usage ? e.message : describeCrash(e); }
    try { repos = loadOrRefuse(clock()); } catch (e) { msg = `${msg} Could not reread the queues: ${describeCrash(e)}`; }
  }

  function runCommand(line) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    try {
      checkFlags(words);
      const v = target(repos, words);
      if (isWrite(v)) {
        // A change typed anywhere lands on that repo's Queue, with the moved ticket selected.
        if (!(view.kind === 'repo' && view.slug === v.slug && tab === 'queue')) { goPlace({ kind: 'repo', slug: v.slug }); tab = 'queue'; }
        if (v.key) selId = v.key;
        act(v);
      } else if (v.kind === 'overview' && view.kind === 'overview') { view = { ...view, all: v.all }; msg = ''; } else goPlace(v);
    } catch (e) { msg = e instanceof Usage ? e.message : describeCrash(e); }
  }

  function onKey(str, key = {}) {
    if (done) return;
    if (key.ctrl && key.name === 'c') return finish(130);
    const rows = screen?.rows ?? [];
    if (cmd != null) {
      if (key.name === 'return' || key.name === 'enter') { const line = cmd; cmd = null; runCommand(line); }
      else if (key.name === 'escape') cmd = null;
      else if (key.name === 'backspace') cmd = cmd.slice(0, -1);
      else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') cmd += str;
      return draw();
    }
    // On a repo's Queue the selected ticket moves; on a ticket's screen, that ticket. On a Timeline
    // or By day nothing moves: the order is set on the Queue, and the dates follow from it.
    const queueView = (view.kind === 'repo' && tab === 'queue') || view.kind === 'ticket';
    const moveVerb = key.shift && key.name === 'up' ? 'up' : key.shift && key.name === 'down' ? 'down' : str === 't' ? 'top' : str === 'b' ? 'bottom' : null;
    const viewNo = VIEWS.findIndex((_, i) => str === String(i + 1));
    if (hasTabs() && key.name === 'tab') {
      const ok = VIEWS.filter(([id]) => tabOk(id));
      const i = ok.findIndex(([id]) => id === tab);
      setTab(ok[(i + (key.shift ? -1 : 1) + ok.length) % ok.length][0]);
    } else if (hasTabs() && viewNo >= 0) setTab(VIEWS[viewNo][0]);
    else if (hasTabs() && str === 'w') setTab('timeline');
    else if (view.kind === 'epic' && moveVerb) msg = REORDER_IN_REPO;
    else if (hasTabs() && tab !== 'queue' && moveVerb) msg = REORDER_HERE;
    else if (queueView && moveVerb) {
      const k = view.kind === 'ticket' ? view.key : rows[sel]?.id;
      if (k && repoOf(view.slug)?.q) act({ kind: 'move', slug: view.slug, key: k, verb: moveVerb });
    } else if (queueView && (str === '+' || str === '-')) {
      const r = repoOf(view.slug);
      if (r?.q) act({ kind: 'workers', slug: r.slug, n: String(r.workers + (str === '+' ? 1 : -1)) });
      else msg = `${r?.name ?? view.slug} has no batch yet.`;
    } else if ((key.name === 'up' || key.name === 'down') && !rows.length) scroll = (scroll ?? 0) + (key.name === 'up' ? -1 : 1);
    else if (key.name === 'up' && scroll > 0) scroll -= 1;
    else if (key.name === 'down' && sel === rows.length - 1) scroll = (scroll ?? 0) + 1;
    else if (key.name === 'up') { sel = Math.max(0, sel - 1); selId = rows[sel]?.id ?? null; }
    else if (key.name === 'down') { sel = Math.min(rows.length - 1, sel + 1); selId = rows[sel]?.id ?? null; }
    else if (key.name === 'return' || key.name === 'enter') { const o = rows[sel]?.open; if (o) go(o); }
    else if (key.name === 'escape') back();
    else if (str === 'q') return finish(0);
    else if (str === ':') { cmd = ''; msg = ''; }
    else if (str === 'a' && view.kind === 'overview' && tab === 'queue') view = { ...view, all: !view.all };
    else if (str === 'z' && hasTabs() && tab === 'timeline') { zoom = ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length]; msg = ''; }
    else if (str === 'c' && view.kind !== 'log') {
      checkin = !checkin;
      msg = checkin ? 'Parked tickets are now dated as if you answer at the next check-in (08:00 or 17:00).' : 'Parked tickets have no date until you answer them.';
    }
    else if (str === 'l' && view.kind === 'ticket') {
      const r = repoOf(view.slug);
      if (r && existsSync(logPath(r, view.key))) go({ ...view, kind: 'log' });
      else msg = `${view.key} has no log yet.`;
    } else if (str === 'o' && view.kind === 'ticket') {
      const url = jiraUrlFor(view.slug, view.key);
      if (!url) msg = `No Jira site in ${repoOf(view.slug)?.name ?? view.slug}'s config, so there is nothing to open.`;
      else { try { opener(url); msg = `Opened ${url}`; } catch (e) { msg = `Could not open ${url}: ${describeCrash(e)}`; } }
    } else return;
    draw();
  }

  goPlace(start);
  emitKeypressEvents(keys);
  if (input.isTTY) input.setRawMode(true);
  keys.on('keypress', onKey);
  input.on('data', onData);
  input.resume?.();
  output.on?.('resize', draw);
  output.write(ENTER_SCREEN);
  timer = setInterval(() => {
    try { repos = loadOrRefuse(clock()); } catch (e) { msg = `Could not reread the queues: ${describeCrash(e)}`; }
    draw();
  }, refreshMs);
  draw();
  return { finish };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  try {
    // A terminal on both ends gets the screen; anything piped, --plain and a change typed in the
    // shell get the plain output.
    let start = null;
    if (process.stdin.isTTY && process.stdout.isTTY && !argv.includes('--plain') && !argv.includes('--help')) {
      checkFlags(argv);
      start = target(loadOrRefuse(Date.now()), argv);
    }
    if (start && !isWrite(start)) {
      const ui = interactive({ start });
      process.on('SIGTERM', () => ui.finish(143));
      process.on('SIGHUP', () => ui.finish(129));
    } else console.log(run(argv));
  } catch (e) { console.error(e instanceof Usage ? e.message : describeCrash(e)); process.exit(1); }
}
