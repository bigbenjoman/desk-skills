// desk-ui's change stream, GET /api/events: server-sent events carrying each change to desk's state.
// A watcher on desk's state folders rebuilds the read model (desk-q's home and repo views) at most
// once per DEBOUNCE_MS, diffs it by repo slug and ticket key against the last one, and sends each
// difference to every open window as its own event, numbered by the revision it makes:
//   snapshot  { at, rev, ...desk-q's home view, tickets: { <slug>: [row] } }   first, and after a gap
//   home      { needs_you, machine, no_batch }                                  the machine-wide totals
//   repo      { slug, summary }      one repo's home-view row; summary null once the repo has gone
//   tickets   { slug, upsert: [row], remove: [key] }                            the rows that moved
//   ping      { at }                 after PING_MS with nothing else sent; carries no revision
// Worker logs (logs/, any *.log), the read-only clones (ref/) and the server's own folder (ui/) are
// not watched: workers write them all the time and they change no count. A clock tick every TICK_MS
// rebuilds when a batch's heartbeat has aged past LIVE_MS (or come back) with no file written.
// The last RING events are kept, so a window that reconnects with Last-Event-ID (or ?since=) gets only
// those after it; a revision the ring no longer covers gets a snapshot first.
import { watch } from 'node:fs';
import { join, sep } from 'node:path';
import * as E from './desk-env.mjs';
import { lastBeat, liveBeat } from './borrow.mjs';

export const DEBOUNCE_MS = 250;
export const TICK_MS = 5000;
export const PING_MS = 15_000;
export const RING = 500;
// A window that stops reading is dropped once this much is waiting for it.
const MAX_BACKLOG = 8 * 1024 * 1024;

// The folders whose writes can change the read model: each batch's state, its queue and each repo's config.
export const stateRoots = () => [join(E.HOME, '.desk-autopilot'), join(E.deskHome(), 'repos'), join(E.deskConfigRoot(), 'repos')];

// Whether a write at `file` (relative to the watched root) can change the read model.
const QUIET = new Set(['logs', 'ref']);
export function counts(file) {
  if (file == null) return true; // the platform did not say which file: assume it counts
  const segs = String(file).split(/[\\/]/).filter(Boolean);
  if (segs[0] === 'ui') return false;
  if (segs.some((s) => QUIET.has(s))) return false;
  return !/\.log(\.|$)/.test(segs.at(-1) ?? '');
}

// The read model: desk-q's home view for every repo with a batch, each repo's ticket rows as its
// repo view lists them (their figures, not the screen's line, which carries ages that move with the
// clock), and each batch's heartbeat liveness, which the clock tick checks.
export async function readModel(now) {
  const Q = await import('./desk-q-model.mjs');
  E.forgetReads(); // the server outlives edits to the machine profile and configs
  const repos = Q.loadRepos(now);
  const { lines, generated_at, ...body } = Q.homeJson(repos, { all: true, now });
  const tickets = {};
  for (const s of body.repos ?? []) {
    const r = s.error ? null : Q.repoPlace(repos, s.id);
    tickets[s.slug] = r ? Q.repoJson(repos, r, { now }).tickets.map(({ line, ...row }) => row) : [];
  }
  const batches = repos.filter((r) => r.queuePath).map((r) => ({ stateDir: r.stateDir, queuePath: r.queuePath, live: !!r.live }));
  return { at: now, body, tickets, batches };
}
// Whether any batch's liveness has moved since the model was read, with nothing written.
export const livenessMoved = (model, now) => model.batches.some((b) => liveBeat(lastBeat(b.stateDir, b.queuePath), now) !== b.live);

// What a change compares: each figure, without the ones that move with the clock alone.
const summaryKey = (s) => { if (!s) return 'null'; const { last_pass, all_done_by, ...rest } = s; return JSON.stringify(rest); };
const homeOf = (body) => ({ needs_you: body.needs_you, machine: body.machine, no_batch: body.no_batch });
const homeKey = (body) => JSON.stringify({ needs: body.needs_you, running: body.machine?.running, cap: body.machine?.cap, none: body.no_batch });

// The events that take a window from `prev` to `next`.
export function diff(prev, next) {
  const out = [];
  const before = new Map((prev.body.repos ?? []).map((s) => [s.slug, s]));
  const after = new Map((next.body.repos ?? []).map((s) => [s.slug, s]));
  for (const slug of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(slug), b = after.get(slug);
    if (summaryKey(a) !== summaryKey(b)) out.push({ event: 'repo', data: { slug, summary: b ?? null } });
    const was = new Map((prev.tickets[slug] ?? []).map((t) => [t.key, JSON.stringify(t)]));
    const now = next.tickets[slug] ?? [];
    const upsert = now.filter((t) => was.get(t.key) !== JSON.stringify(t));
    const keys = new Set(now.map((t) => t.key));
    const remove = [...was.keys()].filter((k) => !keys.has(k));
    if (upsert.length || remove.length) out.push({ event: 'tickets', data: { slug, upsert, remove } });
  }
  if (homeKey(prev.body) !== homeKey(next.body)) out.push({ event: 'home', data: homeOf(next.body) });
  return out;
}

const frame = (event, data, id = null) => `${id == null ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// The feed one server holds. `build(now)` reads the model (readModel), `stale(model, now)` says the clock
// alone has changed it (livenessMoved), `now` is the clock both read. Timers never hold the process open.
export function makeFeed({ build = readModel, stale = livenessMoved, now = Date.now, roots = stateRoots, debounceMs = DEBOUNCE_MS,
  tickMs = TICK_MS, pingMs = PING_MS, ring = RING, onError = (e) => console.error(`desk-ui: events: ${e.message}`) } = {}) {
  let model = null, rev = 0, dirty = false, timer = null, building = null, lastBuild = -Infinity, ticker = null, started = false;
  const held = []; // the last `ring` events: { id, event, data }
  const clients = new Set();
  const watchers = new Map(); // root -> FSWatcher
  const builds = []; // when each rebuild started, for the tests
  const waiting = []; // reads waiting on the rebuild a change scheduled

  const send = (c, text) => {
    if (c.res.writableLength > MAX_BACKLOG) { drop(c); c.res.destroy(); return; }
    c.res.write(text);
    clearTimeout(c.ping);
    c.ping = setTimeout(() => send(c, frame('ping', { at: new Date(now()).toISOString() })), pingMs);
    c.ping.unref?.();
  };
  const drop = (c) => { clearTimeout(c.ping); clients.delete(c); };
  function publish(event, data) {
    rev += 1;
    held.push({ id: rev, event, data });
    if (held.length > ring) held.shift();
    const text = frame(event, data, rev);
    for (const c of clients) send(c, text);
  }

  async function rebuild() {
    clearTimeout(timer); timer = null;
    dirty = false;
    lastBuild = Date.now();
    builds.push(lastBuild);
    try {
      const next = await build(now());
      if (!model) rev += 1; // the first model is a revision of its own, which only a snapshot carries
      else for (const c of diff(model, next)) publish(c.event, c.data);
      model = next;
    } catch (e) { onError(e); }
  }
  function run() {
    building = rebuild().finally(() => {
      building = null;
      for (const r of waiting.splice(0)) r();
      if (dirty) schedule();
    });
    return building;
  }
  // A rebuild once DEBOUNCE_MS has passed since the last one started, so a burst of writes costs one.
  function schedule() {
    dirty = true;
    if (timer || building) return;
    timer = setTimeout(run, Math.max(0, lastBuild + debounceMs - Date.now()));
    timer.unref?.();
  }

  function watchRoots() {
    for (const root of roots()) {
      if (watchers.has(root)) continue;
      try {
        const w = watch(root, { recursive: true }, (_type, file) => { if (counts(file)) schedule(); });
        w.on('error', () => { w.close(); watchers.delete(root); schedule(); });
        watchers.set(root, w);
      } catch { /* not there yet: the next tick tries again */ }
    }
  }
  function tick() {
    watchRoots();
    if (model && !timer && !building && stale(model, now())) schedule();
  }
  function start() {
    if (started) return;
    started = true;
    watchRoots();
    ticker = setInterval(tick, tickMs);
    ticker.unref?.();
  }

  // The model as it stands, built first when there is none or a change is waiting. `fresh` also
  // rebuilds an unchanged one, at most once per DEBOUNCE_MS, for a read of what the watcher does not see.
  async function current({ fresh = false } = {}) {
    start();
    if (building) await building;
    if (!model || (fresh && Date.now() - lastBuild >= debounceMs)) await run();
    else if (dirty) await new Promise((r) => waiting.push(r));
    return model;
  }
  const snapshot = (m = model) => ({ at: new Date(m.at).toISOString(), rev, ...m.body, tickets: m.tickets });

  // The revision a window last saw, from Last-Event-ID or ?since=, or null.
  const since = (req, query) => {
    const raw = req.headers['last-event-id'] ?? query.get('since');
    return raw != null && /^\d+$/.test(String(raw).trim()) ? Number(raw) : null;
  };
  // Opens one window's stream: the events after the revision it names while the ring still holds every
  // one of them, else a snapshot.
  async function subscribe(req, res, { headers = {}, query = new URLSearchParams() } = {}) {
    const m = await current();
    if (!m) return false;
    const after = since(req, query);
    const floor = held.length ? held[0].id - 1 : rev;
    res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    const c = { res, ping: null };
    clients.add(c);
    res.on('close', () => drop(c)); // the window went away (a request's own 'close' fires once it is read)
    if (after != null && after >= floor && after <= rev) for (const e of held.filter((x) => x.id > after)) send(c, frame(e.event, e.data, e.id));
    else send(c, frame('snapshot', snapshot(m), rev));
    // Nothing missed and nothing new: the ping timer `send` sets would not run yet.
    if (!c.ping) { c.ping = setTimeout(() => send(c, frame('ping', { at: new Date(now()).toISOString() })), pingMs); c.ping.unref?.(); }
    return true;
  }

  function stop() {
    clearInterval(ticker); clearTimeout(timer);
    for (const w of watchers.values()) w.close();
    watchers.clear();
    for (const c of [...clients]) { drop(c); c.res.end(); }
    started = false;
  }

  return { current, snapshot, subscribe, stop, tick, schedule, get rev() { return rev; }, get builds() { return builds; }, get clients() { return clients.size; } };
}
